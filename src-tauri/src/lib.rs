//! SSH Cfg Mgr desktop app.
//!
//! The Rust side reads files and does the work. The web UI in `../ui` calls
//! the functions marked `#[tauri::command]` with `invoke("name", args)`, and
//! gets the return value as JSON.

mod store;

use serde::{Deserialize, Serialize};
use sshconfig_lossless::{Block, Directive, SshConfig};
use std::path::{Path, PathBuf};
use tauri::Manager;

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
}

impl From<&Block> for BlockView {
    fn from(block: &Block) -> Self {
        BlockView {
            kind: if block.is_host() { "Host" } else { "Match" },
            pattern: block.pattern().to_string(),
            settings: block.directives().map(Setting::from).collect(),
        }
    }
}

#[derive(Serialize)]
struct ConfigView {
    path: String,
    exists: bool,
    /// Send this back with each change. See [`store::revision`].
    revision: String,
    global: Vec<Setting>,
    blocks: Vec<BlockView>,
    /// True if writing the parsed file gives exactly the same bytes.
    lossless: bool,
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
    ConfigView {
        path: path.display().to_string(),
        exists: loaded.exists,
        revision: store::revision(&loaded.text),
        global: config.global_directives().map(Setting::from).collect(),
        blocks: config.blocks().iter().map(BlockView::from).collect(),
        lossless: config.to_string() == loaded.text,
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
/// or `None` to add a new host.
#[tauri::command]
async fn save_block(
    app: tauri::AppHandle,
    revision: String,
    index: Option<usize>,
    pattern: String,
    settings: Vec<Setting>,
) -> Result<SaveResult, String> {
    let pattern = clean_pattern(&pattern)?;
    let settings = clean_settings(settings)?;

    edit(&app, &revision, |config| {
        let index = match index {
            Some(index) if index < config.blocks().len() => index,
            Some(_) => return Err(CHANGED_ON_DISK.to_string()),
            None => {
                let index = new_host_index(config);
                config.insert_host(index, &pattern);
                index
            }
        };
        let block = config.block_mut(index).expect("index was checked");
        if block.pattern() != pattern {
            block.set_pattern(&pattern);
        }
        apply_settings(block, &settings);
        Ok(Some(index))
    })
}

/// Delete the block at `index`.
#[tauri::command]
async fn delete_block(
    app: tauri::AppHandle,
    revision: String,
    index: usize,
) -> Result<SaveResult, String> {
    edit(&app, &revision, |config| {
        config
            .remove_block(index)
            .ok_or_else(|| CHANGED_ON_DISK.to_string())?;
        Ok(None)
    })
}

/// Read the file, check that it did not change since the UI loaded it,
/// apply `change`, and save.
fn edit(
    app: &tauri::AppHandle,
    revision: &str,
    change: impl FnOnce(&mut SshConfig) -> Result<Option<usize>, String>,
) -> Result<SaveResult, String> {
    let path = config_path(app)?;
    let old = store::read(&path)?;
    if store::revision(&old.text) != revision {
        return Err(CHANGED_ON_DISK.to_string());
    }

    let mut config = SshConfig::parse(&old.text);
    let selected = change(&mut config)?;
    let text = config.to_string();

    if text == old.text {
        return Ok(SaveResult {
            config: view(&path, &old),
            backup: None,
            selected,
        });
    }
    let backup = store::write(&path, &text)?;
    let new = store::Loaded { text, exists: true };
    Ok(SaveResult {
        config: view(&path, &new),
        backup: backup.map(|p| p.display().to_string()),
        selected,
    })
}

/// New hosts go before `Host *`. OpenSSH uses the first value it finds, so
/// a host after `Host *` cannot override the defaults in it.
fn new_host_index(config: &SshConfig) -> usize {
    config
        .blocks()
        .iter()
        .position(|b| b.is_host() && b.patterns() == ["*"])
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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_block,
            delete_block
        ])
        .run(tauri::generate_context!())
        .expect("error while running SSH Cfg Mgr");
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
