//! The SSH keys in `~/.ssh`. Read-only: nothing here writes a file.
//!
//! A key is found by its public half (`*.pub`). `ssh-keygen -l` gives its
//! type, size and fingerprint, so the app needs no crypto code.

use serde::Serialize;
use std::{fs, path::Path, process::Command};

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Key {
    /// The private key path: the `.pub` path without `.pub`.
    pub path: String,
    /// False if only the `.pub` file is there.
    pub has_private: bool,
    /// For example `ED25519` or `RSA`. Empty if ssh-keygen could not read it.
    pub kind: String,
    pub bits: u32,
    /// `SHA256:...`, as `ssh -v` and `ssh-add -l` show it.
    pub fingerprint: String,
    pub comment: String,
}

/// Every `*.pub` file in `dir`, sorted by name.
/// ponytail: a private key without its `.pub` file is not listed.
pub fn list(dir: &Path) -> Vec<Key> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut pubs: Vec<_> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "pub") && p.is_file())
        .collect();
    pubs.sort();
    pubs.iter().map(|p| read(p)).collect()
}

fn read(pub_path: &Path) -> Key {
    let private = pub_path.with_extension("");
    let output = Command::new("ssh-keygen")
        .arg("-l")
        .arg("-f")
        .arg(pub_path)
        .output();
    let line = output
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let mut key = parse(&line).unwrap_or_default();
    key.path = private.display().to_string();
    key.has_private = private.is_file();
    key
}

/// One line of `ssh-keygen -l`: `256 SHA256:abc… me@laptop (ED25519)`.
fn parse(line: &str) -> Option<Key> {
    let (bits, rest) = line.split_once(' ')?;
    let (fingerprint, rest) = rest.split_once(' ').unwrap_or((rest, ""));
    let (comment, kind) = match rest.rsplit_once(" (") {
        Some((comment, kind)) => (comment, kind.strip_suffix(')')?),
        None => ("", rest.strip_prefix('(')?.strip_suffix(')')?),
    };
    Some(Key {
        kind: kind.to_string(),
        bits: bits.parse().ok()?,
        fingerprint: fingerprint.to_string(),
        comment: comment.to_string(),
        ..Key::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_keygen_line() {
        let k = parse("256 SHA256:AbC+/12 me@my laptop (ED25519)").unwrap();
        assert_eq!((k.bits, k.kind.as_str()), (256, "ED25519"));
        assert_eq!(k.fingerprint, "SHA256:AbC+/12");
        assert_eq!(k.comment, "me@my laptop");
    }

    #[test]
    fn parses_line_without_comment() {
        let k = parse("3072 SHA256:xyz (RSA)").unwrap();
        assert_eq!(
            (k.bits, k.kind.as_str(), k.comment.as_str()),
            (3072, "RSA", "")
        );
    }

    #[test]
    fn lists_real_keys() {
        let dir = std::env::temp_dir().join(format!("ssh-cfg-mgr-keys-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let key = dir.join("id_test");
        let made = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "test key", "-f"])
            .arg(&key)
            .status();
        if !made.is_ok_and(|s| s.success()) {
            return; // no ssh-keygen here
        }
        fs::write(dir.join("other.pub"), "not a key\n").unwrap();
        let keys = list(&dir);
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(keys.len(), 2);
        let k = &keys[0];
        assert_eq!(k.path, key.display().to_string());
        assert!(k.has_private);
        assert_eq!(
            (k.kind.as_str(), k.bits, k.comment.as_str()),
            ("ED25519", 256, "test key")
        );
        assert!(k.fingerprint.starts_with("SHA256:"));
        // A bad .pub file is still listed, with no details.
        assert_eq!((keys[1].kind.as_str(), keys[1].has_private), ("", false));
    }
}
