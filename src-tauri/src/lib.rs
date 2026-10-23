//! SSH Cfg Mgr desktop app.
//!
//! The Rust side reads files and does the work. The web UI in `../ui` calls
//! the functions marked `#[tauri::command]` with `invoke("name")`, and gets
//! the return value as JSON.

use serde::Serialize;
use sshconfig_lossless::{Block, Directive, SshConfig};
use std::{fs, io, path::PathBuf};
use tauri::Manager;

/// Set this variable to open another file instead of `~/.ssh/config`.
/// Useful for tests and screenshots.
const CONFIG_ENV: &str = "SSH_CFG_MGR_CONFIG";

/// One `Keyword value` line, as the UI sees it.
#[derive(Serialize)]
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
    /// False if the file does not exist yet. That is not an error.
    exists: bool,
    global: Vec<Setting>,
    blocks: Vec<BlockView>,
    /// True if writing the parsed file gives exactly the same bytes.
    lossless: bool,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os(CONFIG_ENV) {
        return Ok(PathBuf::from(path));
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".ssh").join("config"))
}

/// Read and parse the SSH config. This never writes to the file.
#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<ConfigView, String> {
    let path = config_path(&app)?;

    let (text, exists) = match fs::read_to_string(&path) {
        Ok(text) => (text, true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (String::new(), false),
        Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
    };
    let config = SshConfig::parse(&text);

    Ok(ConfigView {
        path: path.display().to_string(),
        exists,
        global: config.global_directives().map(Setting::from).collect(),
        blocks: config.blocks().iter().map(BlockView::from).collect(),
        lossless: config.to_string() == text,
    })
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_config])
        .run(tauri::generate_context!())
        .expect("error while running SSH Cfg Mgr");
}
