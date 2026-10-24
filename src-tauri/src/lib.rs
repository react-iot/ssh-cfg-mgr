//! SSH Config Manager desktop app.
//!
//! The Rust side reads files and does the work. The web UI in `../ui` calls
//! the functions marked `#[tauri::command]` with `invoke("name", args)`, and
//! gets the return value as JSON.

mod include;
mod keys;
mod store;

use serde::{Deserialize, Serialize};
use sshconfig_lossless::{Block, Directive, SshConfig};
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};

/// Set this variable to open another file instead of `~/.ssh/config`.
/// Useful for tests and screenshots.
const CONFIG_ENV: &str = "SSH_CFG_MGR_CONFIG";

const CHANGED_ON_DISK: &str = "The file changed on disk after you opened it. Nothing was saved. Reload, then make your change again.";

/// One `Keyword value` line, as the UI sees it.
#[derive(Serialize, Deserialize)]
struct Setting {
    keyword: String,
    value: String,
}

impl From<&Directive> for Setting {
    fn from(d: &Directive) -> Self {
        Setting {
            keyword: d.keyword().to_string(),
            value: d.value().to_string(),
        }
    }
}

/// One `Host` or `Match` block, as the UI sees it.
#[derive(Serialize)]
struct BlockView {
    /// `"Host"` or `"Match"`.
    kind: &'static str,
    pattern: String,
    settings: Vec<Setting>,
    /// The name from a `# group: <name>` comment above the block.
    group_comment: Option<String>,
    /// False if the block is turned off (its lines start with `#~`).
    enabled: bool,
    /// The block's lines as written, for the raw editor.
    raw: String,
}

impl BlockView {
    fn new(config: &SshConfig, index: usize) -> Self {
        let block = &config.blocks()[index];
        BlockView {
            kind: if block.is_host() { "Host" } else { "Match" },
            pattern: block.pattern().to_string(),
            settings: block.directives().map(Setting::from).collect(),
            group_comment: config
                .comments_above(index)
                .into_iter()
                .find_map(group_from_comment)
                .map(str::to_string),
            enabled: block.is_enabled(),
            raw: config.block_text(index).unwrap_or_default(),
        }
    }
}

/// Where a block's group is stored. The user picks this in the UI.
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum GroupMode {
    /// A `# group: <name>` comment above the block. OpenSSH ignores it.
    Comment,
    /// A `Tag <name>` directive in the block. Needs OpenSSH 9.4 or later.
    Tag,
}

const GROUP_PREFIX: &str = "group:";

/// `# group: Work` gives `Some("Work")`.
fn group_from_comment(text: &str) -> Option<&str> {
    let rest = text.trim_start().strip_prefix('#')?.trim_start();
    let prefix = rest.get(..GROUP_PREFIX.len())?;
    prefix
        .eq_ignore_ascii_case(GROUP_PREFIX)
        .then(|| rest[GROUP_PREFIX.len()..].trim())
        .filter(|name| !name.is_empty())
}

#[derive(Serialize)]
struct ConfigView {
    path: String,
    exists: bool,
    /// Send this back with each change. See [`store::revision`].
    revision: String,
    global: Vec<Setting>,
    /// The global lines as written, for the raw editor.
    global_raw: String,
    blocks: Vec<BlockView>,
    /// True if writing the parsed file gives exactly the same bytes.
    lossless: bool,
    /// The home folder, so the UI can write picked paths as `~/...`.
    home: String,
    /// The whole file, to compare with a backup in the history view.
    text: String,
    /// Files brought in by Include lines, in the order ssh reads them.
    included: Vec<IncludedView>,
}

#[derive(Serialize)]
struct SaveResult {
    config: ConfigView,
    /// The backup of the old file, if one was made.
    backup: Option<String>,
    /// The index of the block that was saved, so the UI can select it.
    selected: Option<usize>,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os(CONFIG_ENV) {
        return Ok(PathBuf::from(path));
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".ssh").join("config"))
}

fn view(path: &Path, loaded: &store::Loaded) -> ConfigView {
    let config = SshConfig::parse(&loaded.text);
    let home = std::env::var("HOME").unwrap_or_default();
    ConfigView {
        path: path.display().to_string(),
        exists: loaded.exists,
        revision: store::revision(&loaded.text),
        global: config.global_directives().map(Setting::from).collect(),
        global_raw: config.global_text(),
        blocks: (0..config.blocks().len())
            .map(|i| BlockView::new(&config, i))
            .collect(),
        lossless: config.to_string() == loaded.text,
        home: home.clone(),
        text: loaded.text.clone(),
        included: include::resolve(path, &config, Path::new(&home))
            .into_iter()
            .map(IncludedView::from)
            .collect(),
    }
}

/// A file brought in by an Include line, with its blocks (read-only).
#[derive(Serialize)]
struct IncludedView {
    #[serde(flatten)]
    file: include::IncludedFile,
    blocks: Vec<BlockView>,
}

impl From<include::IncludedFile> for IncludedView {
    fn from(file: include::IncludedFile) -> Self {
        let blocks = file
            .config
            .as_ref()
            .map(|c| {
                (0..c.blocks().len())
                    .map(|i| BlockView::new(c, i))
                    .collect()
            })
            .unwrap_or_default();
        IncludedView { file, blocks }
    }
}

/// Read and parse the SSH config. This never writes to the file.
#[tauri::command]
async fn load_config(app: tauri::AppHandle) -> Result<ConfigView, String> {
    let path = config_path(&app)?;
    let loaded = store::read(&path)?;
    Ok(view(&path, &loaded))
}

/// Save one block. `index` is the block's position in `ConfigView.blocks`,
/// or `None` to add a new host. `group` is stored as `group_mode` says;
/// an empty group removes it.
#[tauri::command]
// Tauri sends each argument by name from JS; a struct would add nothing.
#[allow(clippy::too_many_arguments)]
async fn save_block(
    app: tauri::AppHandle,
    revision: String,
    file: Option<String>,
    index: Option<usize>,
    pattern: String,
    settings: Vec<Setting>,
    group: String,
    group_mode: GroupMode,
) -> Result<SaveResult, String> {
    let pattern = clean_pattern(&pattern)?;
    let settings = clean_settings(settings)?;
    let group = clean_group(&group, group_mode)?;

    edit_file(&app, file.as_deref(), &revision, |config| {
        let index = match index {
            Some(index) if index < config.blocks().len() => index,
            Some(_) => return Err(CHANGED_ON_DISK.to_string()),
            None => {
                let index = new_host_index(config);
                config.insert_host(index, &pattern);
                index
            }
        };
        apply_block(
            config,
            index,
            &pattern,
            settings,
            group.as_deref(),
            group_mode,
        );
        Ok(Some(index))
    })
}

fn apply_block(
    config: &mut SshConfig,
    index: usize,
    pattern: &str,
    mut settings: Vec<Setting>,
    group: Option<&str>,
    group_mode: GroupMode,
) {
    if let GroupMode::Tag = group_mode {
        // The group is the Tag. Put it in the settings, so an existing Tag
        // line changes in place.
        settings.retain(|s| !s.keyword.eq_ignore_ascii_case("Tag"));
        settings.extend(group.map(|g| Setting {
            keyword: "Tag".into(),
            value: g.into(),
        }));
    }
    let block = config.block_mut(index).expect("index was checked");
    if block.pattern() != pattern {
        block.set_pattern(pattern);
    }
    apply_settings(block, &settings);
    if let GroupMode::Comment = group_mode {
        let comment = group.map(|g| format!("# {GROUP_PREFIX} {g}"));
        let is_group = |t: &str| group_from_comment(t).is_some();
        config.set_comment_above(index, is_group, comment.as_deref());
    }
}

/// Delete the block at `index`.
#[tauri::command]
async fn delete_block(
    app: tauri::AppHandle,
    revision: String,
    file: Option<String>,
    index: usize,
) -> Result<SaveResult, String> {
    edit_file(&app, file.as_deref(), &revision, |config| {
        config
            .remove_block(index)
            .ok_or_else(|| CHANGED_ON_DISK.to_string())?;
        Ok(None)
    })
}

/// Replace the lines of the block at `index` with `text`, as typed. The
/// save checks the whole file with `ssh -G`, as every save does.
#[tauri::command]
async fn save_block_raw(
    app: tauri::AppHandle,
    revision: String,
    file: Option<String>,
    index: usize,
    text: String,
) -> Result<SaveResult, String> {
    edit_file(&app, file.as_deref(), &revision, |config| {
        if index >= config.blocks().len() {
            return Err(CHANGED_ON_DISK.to_string());
        }
        config.set_block_text(index, &text)?;
        Ok(Some(index))
    })
}

/// Move a line before the first block (an Include line), from global
/// directive index `from` to `to`. OpenSSH reads Include lines in order.
#[tauri::command]
async fn move_global_line(
    app: tauri::AppHandle,
    revision: String,
    from: usize,
    to: usize,
) -> Result<SaveResult, String> {
    edit(&app, &revision, |config| {
        if !config.move_global_directive(from, to) {
            return Err(CHANGED_ON_DISK.to_string());
        }
        Ok(None)
    })
}

/// Save the settings before the first Host or Match line, which apply to
/// every host. Comments and Include order stay as they are.
#[tauri::command]
async fn save_global(
    app: tauri::AppHandle,
    revision: String,
    settings: Vec<Setting>,
) -> Result<SaveResult, String> {
    let settings = clean_settings(settings)?;
    edit(&app, &revision, |config| {
        config.edit_global(|global| apply_settings(global, &settings));
        Ok(None)
    })
}

/// Replace the global lines with `text` from the raw editor.
#[tauri::command]
async fn save_global_raw(
    app: tauri::AppHandle,
    revision: String,
    text: String,
) -> Result<SaveResult, String> {
    edit(&app, &revision, |config| {
        config.set_global_text(&text)?;
        Ok(None)
    })
}

/// Move the block at `from` to position `to`, with the comments above it.
/// Order matters: OpenSSH uses the first value it finds.
#[tauri::command]
async fn move_block(
    app: tauri::AppHandle,
    revision: String,
    file: Option<String>,
    from: usize,
    to: usize,
) -> Result<SaveResult, String> {
    edit_file(&app, file.as_deref(), &revision, |config| {
        if !config.move_block(from, to) {
            return Err(CHANGED_ON_DISK.to_string());
        }
        Ok(Some(to))
    })
}

/// The keys in ~/.ssh. Which hosts use them is worked out in the UI, which
/// has every block.
#[tauri::command]
async fn list_keys(app: tauri::AppHandle) -> Result<Vec<keys::Key>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(keys::list(&home.join(".ssh")))
}

/// The backups of the config, newest first.
#[tauri::command]
async fn list_backups(app: tauri::AppHandle) -> Result<Vec<store::Backup>, String> {
    Ok(store::list_backups(&config_path(&app)?))
}

/// Delete all backups. The config itself is not changed.
#[tauri::command]
async fn clear_backups(app: tauri::AppHandle) -> Result<usize, String> {
    store::clear_backups(&config_path(&app)?)
}

/// The text of one backup, to show and compare.
#[tauri::command]
async fn read_backup(app: tauri::AppHandle, name: String) -> Result<String, String> {
    store::read_backup(&config_path(&app)?, &name)
}

/// Make the config the same as a backup. This is a normal save: it is
/// checked with `ssh -G`, and the current file is backed up first, so a
/// restore can be undone from the history too.
#[tauri::command]
async fn restore_backup(
    app: tauri::AppHandle,
    revision: String,
    name: String,
) -> Result<SaveResult, String> {
    let text = store::read_backup(&config_path(&app)?, &name)?;
    edit(&app, &revision, |config| {
        *config = SshConfig::parse(&text);
        Ok(None)
    })
}

/// Turn the block at `index` on or off. Off comments it out with `#~`, so
/// OpenSSH ignores it; on restores it.
#[tauri::command]
async fn set_block_enabled(
    app: tauri::AppHandle,
    revision: String,
    file: Option<String>,
    index: usize,
    enabled: bool,
) -> Result<SaveResult, String> {
    edit_file(&app, file.as_deref(), &revision, |config| {
        config
            .block_mut(index)
            .ok_or_else(|| CHANGED_ON_DISK.to_string())?
            .set_enabled(enabled);
        Ok(Some(index))
    })
}

/// Read the file, check that it did not change since the UI loaded it,
/// apply `change`, and save.
fn edit(
    app: &tauri::AppHandle,
    revision: &str,
    change: impl FnOnce(&mut SshConfig) -> Result<Option<usize>, String>,
) -> Result<SaveResult, String> {
    edit_file(app, None, revision, change)
}

/// As [`edit`], for the main config (`file` None) or one of its included
/// files. An included file must be listed by the config's Include lines
/// and be inside ~/.ssh; the UI cannot ask to write any other path.
fn edit_file(
    app: &tauri::AppHandle,
    file: Option<&str>,
    revision: &str,
    change: impl FnOnce(&mut SshConfig) -> Result<Option<usize>, String>,
) -> Result<SaveResult, String> {
    let main = config_path(app)?;
    let path = match file {
        None => main.clone(),
        Some(file) => editable_include(&main, file)?,
    };
    let old = store::read(&path)?;
    if store::revision(&old.text) != revision {
        return Err(CHANGED_ON_DISK.to_string());
    }

    let mut config = SshConfig::parse(&old.text);
    let selected = change(&mut config)?;
    let text = config.to_string();

    if text != old.text {
        let backup = store::write(&path, &text)?;
        // The view is always the main config's; it lists included files.
        return Ok(SaveResult {
            config: view(&main, &store::read(&main)?),
            backup: backup.map(|p| p.display().to_string()),
            selected,
        });
    }
    Ok(SaveResult {
        config: view(&main, &store::read(&main)?),
        backup: None,
        selected,
    })
}

/// `file` if it is an editable file included by the config at `main`.
fn editable_include(main: &Path, file: &str) -> Result<PathBuf, String> {
    let loaded = store::read(main)?;
    let config = SshConfig::parse(&loaded.text);
    let home = std::env::var("HOME").unwrap_or_default();
    let found = include::resolve(main, &config, Path::new(&home));
    match found.iter().find(|f| f.file == file) {
        Some(f) if f.editable => Ok(PathBuf::from(&f.file)),
        Some(_) => Err(format!(
            "{file} is outside ~/.ssh, so this app does not change it."
        )),
        None => Err(format!(
            "{file} is not included by the config any more. Reload."
        )),
    }
}

/// New hosts go before `Host *`. OpenSSH uses the first value it finds, so
/// a host after `Host *` cannot override the defaults in it. A turned-off
/// `Host *` does not count.
fn new_host_index(config: &SshConfig) -> usize {
    config
        .blocks()
        .iter()
        .position(|b| b.is_enabled() && b.is_host() && b.patterns() == ["*"])
        .unwrap_or(config.blocks().len())
}

/// Make the block's settings equal to `settings`. Lines that did not change
/// stay exactly as they are in the file.
fn apply_settings(block: &mut Block, settings: &[Setting]) {
    // Old keywords first (to remove the ones that are gone), then new ones,
    // each keyword once.
    let mut keywords: Vec<String> = Vec::new();
    let old = block.directives().map(|d| d.keyword().to_string());
    let new = settings.iter().map(|s| s.keyword.clone());
    for keyword in old.chain(new) {
        if !keywords.iter().any(|k| k.eq_ignore_ascii_case(&keyword)) {
            keywords.push(keyword);
        }
    }

    for keyword in &keywords {
        let values: Vec<&str> = settings
            .iter()
            .filter(|s| s.keyword.eq_ignore_ascii_case(keyword))
            .map(|s| s.value.as_str())
            .collect();
        block.set_all(keyword, &values);
    }
}

fn clean_pattern(pattern: &str) -> Result<String, String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err("The host pattern is empty.".into());
    }
    if pattern.contains(['\n', '\r']) {
        return Err("The host pattern must be on one line.".into());
    }
    Ok(pattern.to_string())
}

/// An empty group means "no group". A Tag takes one word.
fn clean_group(group: &str, mode: GroupMode) -> Result<Option<String>, String> {
    let group = group.trim();
    if group.is_empty() {
        return Ok(None);
    }
    if group.contains(['\n', '\r']) {
        return Err("The group name must be on one line.".into());
    }
    if matches!(mode, GroupMode::Tag) && group.contains(char::is_whitespace) {
        return Err("A Tag group name cannot have spaces.".into());
    }
    Ok(Some(group.to_string()))
}

/// Trim each setting, remove empty rows, and reject values that would
/// break the file.
fn clean_settings(settings: Vec<Setting>) -> Result<Vec<Setting>, String> {
    let mut clean = Vec::new();
    for Setting { keyword, value } in settings {
        let (keyword, value) = (keyword.trim(), value.trim());
        if keyword.is_empty() && value.is_empty() {
            continue;
        }
        if keyword.is_empty() {
            return Err(format!("The value \"{value}\" has no keyword."));
        }
        if !keyword.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(format!(
                "\"{keyword}\" is not a valid keyword. Use letters and numbers only."
            ));
        }
        if keyword.eq_ignore_ascii_case("Host") || keyword.eq_ignore_ascii_case("Match") {
            return Err(format!(
                "{keyword} cannot be a setting. Change the pattern instead."
            ));
        }
        if value.is_empty() {
            return Err(format!("{keyword} has no value."));
        }
        if value.contains(['\n', '\r']) {
            return Err(format!("The value of {keyword} must be on one line."));
        }
        clean.push(Setting {
            keyword: keyword.to_string(),
            value: value.to_string(),
        });
    }
    Ok(clean)
}

/// The menu event that opens the About dialog in the UI.
const ABOUT_ID: &str = "about";

/// Tauri's default menu, with its About item replaced by one that opens our
/// own About dialog. The native panel shows credits as plain text (muda
/// passes a plain NSAttributedString), so it cannot center them or link.
fn menu_with_about(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let about = MenuItem::with_id(
        app,
        ABOUT_ID,
        "About SSH Config Manager",
        true,
        None::<&str>,
    )?;

    // Where Menu::default puts About: first item of the app menu on macOS,
    // first item of Help (the last menu) elsewhere.
    let items = menu.items()?;
    let submenu = if cfg!(target_os = "macos") {
        items.first()
    } else {
        items.last()
    };
    if let Some(submenu) = submenu.and_then(|item| item.as_submenu()) {
        submenu.remove_at(0)?;
        submenu.insert(&about, 0)?;
    }
    Ok(menu)
}

pub fn run() {
    tauri::Builder::default()
        // The file picker for IdentityFile and other path keywords.
        .plugin(tauri_plugin_dialog::init())
        // Opens the About dialog's links in the browser.
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_block,
            delete_block,
            set_block_enabled,
            save_block_raw,
            list_backups,
            read_backup,
            restore_backup,
            move_block,
            clear_backups,
            move_global_line,
            save_global,
            save_global_raw,
            list_keys
        ])
        .setup(|app| {
            app.set_menu(menu_with_about(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == ABOUT_ID {
                let _ = app.emit("show-about", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running SSH Config Manager");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setting(keyword: &str, value: &str) -> Setting {
        Setting {
            keyword: keyword.into(),
            value: value.into(),
        }
    }

    #[test]
    fn apply_settings_changes_only_what_changed() {
        let text = "Host gw\n\tUser root  \n\tIdentityFile ~/.ssh/a\n\tPort 22\n";
        let mut config = SshConfig::parse(text);
        let block = config.block_mut(0).unwrap();
        apply_settings(
            block,
            &[
                setting("User", "root"),
                setting("IdentityFile", "~/.ssh/a"),
                setting("IdentityFile", "~/.ssh/b"),
                setting("ProxyJump", "edge"),
            ],
        );
        assert_eq!(
            config.to_string(),
            "Host gw\n\tUser root  \n\tIdentityFile ~/.ssh/a\n\tIdentityFile ~/.ssh/b\n\tProxyJump edge\n"
        );
    }

    #[test]
    fn new_host_goes_before_catch_all() {
        let config = SshConfig::parse("Host a\nHost *\n    User x\n");
        assert_eq!(new_host_index(&config), 1);
        let config = SshConfig::parse("Host a\n");
        assert_eq!(new_host_index(&config), 1);
        let config = SshConfig::parse("#~Host *\nHost a\nHost *\n");
        assert_eq!(new_host_index(&config), 2);
    }

    #[test]
    fn group_comment_is_read_and_written() {
        assert_eq!(group_from_comment("# group: Work"), Some("Work"));
        assert_eq!(group_from_comment("  #Group:  Home lab "), Some("Home lab"));
        assert_eq!(group_from_comment("# group:"), None);
        assert_eq!(group_from_comment("# grouping"), None);

        let text = "Host a\n    User x\n\nHost b\n";
        let mut config = SshConfig::parse(text);
        let settings = || vec![setting("User", "x")];
        apply_block(
            &mut config,
            0,
            "a",
            settings(),
            Some("Work"),
            GroupMode::Comment,
        );
        assert_eq!(config.to_string(), format!("# group: Work\n{text}"));
        assert_eq!(
            BlockView::new(&config, 0).group_comment.as_deref(),
            Some("Work")
        );
        assert_eq!(BlockView::new(&config, 1).group_comment, None);

        apply_block(&mut config, 0, "a", settings(), None, GroupMode::Comment);
        assert_eq!(config.to_string(), text);
    }

    #[test]
    fn group_tag_changes_in_place() {
        let text = "Host a\n    Tag old\n    User x\n";
        let mut config = SshConfig::parse(text);
        // The UI does not send the Tag as a setting in Tag mode.
        let settings = || vec![setting("User", "x")];
        apply_block(&mut config, 0, "a", settings(), Some("new"), GroupMode::Tag);
        assert_eq!(config.to_string(), text.replace("old", "new"));

        apply_block(&mut config, 0, "a", settings(), None, GroupMode::Tag);
        assert_eq!(config.to_string(), "Host a\n    User x\n");
    }

    #[test]
    fn raw_edit_is_checked_by_ssh() {
        let dir = std::env::temp_dir().join(format!("ssh-cfg-mgr-raw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config");
        let text = "Host a\n    User x\n";
        std::fs::write(&path, text).unwrap();

        let mut config = SshConfig::parse(text);
        config
            .set_block_text(0, "Host a\n    HostNme typo\n")
            .unwrap();
        let error = store::write(&path, &config.to_string()).unwrap_err();
        assert!(error.contains("Bad configuration option"), "{error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);

        config.set_block_text(0, "Host a\n    User y\n").unwrap();
        store::write(&path, &config.to_string()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "Host a\n    User y\n"
        );
    }

    #[test]
    fn clean_group_rules() {
        assert_eq!(clean_group("  ", GroupMode::Tag).unwrap(), None);
        assert_eq!(
            clean_group(" Home lab ", GroupMode::Comment)
                .unwrap()
                .as_deref(),
            Some("Home lab")
        );
        assert!(clean_group("Home lab", GroupMode::Tag).is_err());
        assert!(clean_group("a\nHost evil", GroupMode::Comment).is_err());
    }

    #[test]
    fn clean_settings_rules() {
        let ok = clean_settings(vec![setting(" User ", " x "), setting("", "")]).unwrap();
        assert_eq!(ok.len(), 1);
        assert_eq!(
            (ok[0].keyword.as_str(), ok[0].value.as_str()),
            ("User", "x")
        );

        assert!(clean_settings(vec![setting("Host", "x")]).is_err());
        assert!(clean_settings(vec![setting("User", "")]).is_err());
        assert!(clean_settings(vec![setting("Bad Key", "x")]).is_err());
        assert!(clean_settings(vec![setting("User", "a\nHost evil")]).is_err());
    }
}
