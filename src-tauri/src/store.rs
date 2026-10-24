//! Safe reading and writing of the SSH config file.
//!
//! A save never leaves a half-written or invalid config:
//!
//! 1. Write the new text to a temporary file in the same folder (mode 0600).
//! 2. Check it with `ssh -G -F <temp file>`. Stop if OpenSSH rejects it.
//! 3. Copy the old file to the backup folder.
//! 4. Rename the temporary file over the config. A rename is atomic.
//!
//! This module uses Unix file modes. The app supports macOS and Linux only.

use std::{
    collections::hash_map::DefaultHasher,
    fs::{self, DirBuilder, OpenOptions},
    hash::{Hash, Hasher},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Folder for backups, next to the config file.
pub const BACKUP_DIR: &str = "ssh-cfg-mgr-backups";
const MAX_BACKUPS: usize = 50;

/// `ssh -G` needs a host name. `.invalid` is reserved and never resolves,
/// so `Host` and `Match host` lines for real hosts do not match it.
const CHECK_HOST: &str = "ssh-cfg-mgr-check.invalid";
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Loaded {
    pub text: String,
    /// False if the file does not exist yet. That is not an error.
    pub exists: bool,
}

pub fn read(path: &Path) -> Result<Loaded, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Loaded { text, exists: true }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Loaded {
            text: String::new(),
            exists: false,
        }),
        Err(e) => Err(format!("Cannot read {}: {e}", path.display())),
    }
}

/// A short fingerprint of the file text. The UI sends it back when it
/// saves, so that we can see if the file changed after the UI loaded it.
pub fn revision(text: &str) -> String {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Write `text` to the config at `path`. Returns the backup file, if the
/// config existed before.
pub fn write(path: &Path, text: &str) -> Result<Option<PathBuf>, String> {
    // Write to the real file if `path` is a symlink. Dotfile managers often
    // link ~/.ssh/config, and a rename over the link would break that.
    let target = match fs::canonicalize(path) {
        Ok(target) => target,
        Err(e) if e.kind() == io::ErrorKind::NotFound => path.to_path_buf(),
        Err(e) => return Err(format!("Cannot open {}: {e}", path.display())),
    };
    let dir = target
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", target.display()))?;
    create_private_dir(dir)?;

    let old_mode = fs::metadata(&target)
        .ok()
        .map(|m| m.permissions().mode() & 0o777);
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    let temp = dir.join(format!(".{file_name}.ssh-cfg-mgr.tmp"));

    let result = write_private(&temp, text, old_mode.unwrap_or(0o600))
        .and_then(|()| check(&temp))
        .and_then(|()| match old_mode {
            // Backups go next to `path`, not next to a symlink target that
            // may be in a git repository.
            Some(_) => backup(&target, path).map(Some),
            None => Ok(None),
        })
        .and_then(|backup| {
            fs::rename(&temp, &target)
                .map_err(|e| format!("Cannot replace {}: {e}", target.display()))?;
            Ok(backup)
        });

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn create_private_dir(dir: &Path) -> Result<(), String> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("Cannot make folder {}: {e}", dir.display()))
}

fn write_private(path: &Path, text: &str, mode: u32) -> Result<(), String> {
    let fail = |e: io::Error| format!("Cannot write {}: {e}", path.display());

    // An old temp file can have other permissions. `mode()` applies only
    // when the file is made, so remove it first.
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(fail(e)),
        _ => {}
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
        .map_err(fail)?;
    file.write_all(text.as_bytes()).map_err(fail)?;
    file.sync_all().map_err(fail)?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(fail)
}

/// Ask OpenSSH to read the file. It stops at the first bad line.
fn check(path: &Path) -> Result<(), String> {
    let mut child = Command::new("ssh")
        .arg("-G")
        .arg("-F")
        .arg(path)
        .arg(CHECK_HOST)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => {
                "Cannot check the config: the `ssh` command is not installed.".to_string()
            }
            _ => format!("Cannot run ssh to check the config: {e}"),
        })?;

    // A `Match exec` line runs a command. Do not wait for ever.
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > CHECK_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The config check (ssh -G) took too long and was stopped.".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(format!("Cannot check the config: {e}")),
        }
    };
    if status.success() {
        return Ok(());
    }

    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    // ssh writes "<file>: line 2: Bad configuration option: x". The temp
    // file name means nothing to the user.
    let prefix = format!("{}: ", path.display());
    let message: Vec<&str> = stderr
        .lines()
        .map(|line| line.strip_prefix(&prefix).unwrap_or(line))
        .filter(|line| !line.starts_with("terminating,"))
        .collect();
    Err(format!(
        "OpenSSH does not accept the new config. Nothing was saved.\n{}",
        message.join("\n")
    ))
}

/// Copy `target` into the backup folder next to `path`. Keep only the
/// newest backups.
fn backup(target: &Path, path: &Path) -> Result<PathBuf, String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", path.display()))?
        .join(BACKUP_DIR);
    create_private_dir(&dir)?;

    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let mut dest = dir.join(format!("config-{seconds}.bak"));
    let mut n = 1;
    while dest.exists() {
        dest = dir.join(format!("config-{seconds}-{n}.bak"));
        n += 1;
    }
    fs::copy(target, &dest).map_err(|e| format!("Cannot make backup {}: {e}", dest.display()))?;

    prune(&dir);
    Ok(dest)
}

/// Delete the oldest backups. A failure here does not stop the save.
fn prune(dir: &Path) {
    let backups = backups_in(dir);
    for old in backups.iter().skip(MAX_BACKUPS) {
        let _ = fs::remove_file(dir.join(&old.name));
    }
}

/// One backup file, for the history list.
#[derive(serde::Serialize)]
pub struct Backup {
    pub name: String,
    /// When the backup was made, in seconds since 1970.
    pub time: u64,
    pub size: u64,
}

/// The time in a backup name: `config-<seconds>.bak` or
/// `config-<seconds>-<n>.bak`. The file's mtime is no use: on macOS
/// `fs::copy` keeps the mtime of the config it copied.
fn backup_time(name: &str) -> Option<(u64, u64)> {
    let stem = name.strip_prefix("config-")?.strip_suffix(".bak")?;
    let (seconds, n) = stem.split_once('-').unwrap_or((stem, "0"));
    Some((seconds.parse().ok()?, n.parse().ok()?))
}

/// Backups in `dir`, newest first.
fn backups_in(dir: &Path) -> Vec<Backup> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut backups: Vec<(u64, u64, Backup)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let (time, n) = backup_time(&name)?;
            let size = e.metadata().ok()?.len();
            Some((time, n, Backup { name, time, size }))
        })
        .collect();
    backups.sort_by_key(|b| std::cmp::Reverse((b.0, b.1)));
    backups.into_iter().map(|(_, _, b)| b).collect()
}

fn backup_dir(path: &Path) -> PathBuf {
    path.parent().unwrap_or(Path::new(".")).join(BACKUP_DIR)
}

/// The backups of the config at `path`, newest first.
pub fn list_backups(path: &Path) -> Vec<Backup> {
    backups_in(&backup_dir(path))
}

/// Delete every backup of the config at `path`. Only backup files are
/// deleted; the config itself is not touched. Returns how many.
pub fn clear_backups(path: &Path) -> Result<usize, String> {
    let dir = backup_dir(path);
    let mut deleted = 0;
    for backup in backups_in(&dir) {
        let file = dir.join(&backup.name);
        fs::remove_file(&file).map_err(|e| format!("Cannot delete {}: {e}", file.display()))?;
        deleted += 1;
    }
    Ok(deleted)
}

/// The text of one backup. `name` must be a backup file name, so this
/// cannot read any other file.
pub fn read_backup(path: &Path, name: &str) -> Result<String, String> {
    if name.contains(['/', '\\']) || backup_time(name).is_none() {
        return Err(format!("\"{name}\" is not a backup."));
    }
    let file = backup_dir(path).join(name);
    fs::read_to_string(&file).map_err(|e| format!("Cannot read {}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// A new empty folder for one test.
    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ssh-cfg-mgr-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn backups(dir: &Path) -> Vec<PathBuf> {
        match fs::read_dir(dir.join(BACKUP_DIR)) {
            Ok(entries) => entries.map(|e| e.unwrap().path()).collect(),
            Err(_) => Vec::new(),
        }
    }

    #[test]
    fn new_file_is_private_and_has_no_backup() {
        let dir = temp_dir("new");
        let path = dir.join(".ssh").join("config");

        let backup = write(&path, "Host a\n    User x\n").unwrap();

        assert!(backup.is_none());
        assert_eq!(fs::read_to_string(&path).unwrap(), "Host a\n    User x\n");
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
    }

    #[test]
    fn existing_file_gets_backup_and_keeps_mode() {
        let dir = temp_dir("existing");
        let path = dir.join("config");
        fs::write(&path, "Host old\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        let backup = write(&path, "Host new\n").unwrap().unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "Host new\n");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "Host old\n");
        assert_eq!(mode(&path), 0o644);
    }

    #[test]
    fn invalid_config_is_not_saved() {
        let dir = temp_dir("invalid");
        let path = dir.join("config");
        fs::write(&path, "Host a\n").unwrap();

        let error = write(&path, "Host a\n    HostNme x\n").unwrap_err();

        assert!(
            error.contains("line 2: Bad configuration option: hostnme"),
            "{error}"
        );
        assert!(!error.contains(".ssh-cfg-mgr.tmp"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "Host a\n");
        assert!(backups(&dir).is_empty());
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec!["config"], "temp file must be removed");
    }

    #[test]
    fn symlink_stays_a_symlink() {
        let dir = temp_dir("symlink");
        let dotfiles = dir.join("dotfiles");
        fs::create_dir(&dotfiles).unwrap();
        let real = dotfiles.join("ssh_config");
        fs::write(&real, "Host old\n").unwrap();
        let link = dir.join("config");
        symlink(&real, &link).unwrap();

        write(&link, "Host new\n").unwrap();

        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read_to_string(&real).unwrap(), "Host new\n");
        assert_eq!(backups(&dir).len(), 1, "backup goes next to the link");
        assert!(!dotfiles.join(BACKUP_DIR).exists());
    }

    #[test]
    fn backups_are_listed_newest_first_by_name_time() {
        let dir = temp_dir("history");
        let path = dir.join("config");
        let backups = dir.join(BACKUP_DIR);
        fs::create_dir(&backups).unwrap();
        for name in [
            "config-100.bak",
            "config-300.bak",
            "config-300-1.bak",
            "config-200.bak",
            "notes.txt",
        ] {
            fs::write(backups.join(name), name).unwrap();
        }
        let names: Vec<String> = list_backups(&path).into_iter().map(|b| b.name).collect();
        assert_eq!(
            names,
            [
                "config-300-1.bak",
                "config-300.bak",
                "config-200.bak",
                "config-100.bak"
            ]
        );

        assert_eq!(
            read_backup(&path, "config-200.bak").unwrap(),
            "config-200.bak"
        );
        assert!(read_backup(&path, "../config").is_err());
        assert!(read_backup(&path, "notes.txt").is_err());
        assert!(read_backup(&path, "config-1.bak/../../x").is_err());
    }

    #[test]
    fn clear_backups_deletes_only_backups() {
        let dir = temp_dir("clear");
        let path = dir.join("config");
        fs::write(&path, "Host a\n").unwrap();
        let backups = dir.join(BACKUP_DIR);
        fs::create_dir(&backups).unwrap();
        for name in ["config-1.bak", "config-2-1.bak", "notes.txt"] {
            fs::write(backups.join(name), "x").unwrap();
        }
        assert_eq!(clear_backups(&path).unwrap(), 2);
        assert!(list_backups(&path).is_empty());
        assert!(backups.join("notes.txt").exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "Host a\n");
    }

    #[test]
    fn revision_changes_with_text() {
        assert_eq!(revision("a"), revision("a"));
        assert_ne!(revision("a"), revision("b"));
    }
}
