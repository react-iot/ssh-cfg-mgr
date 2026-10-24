//! The SSH keys in `~/.ssh`: list them, and make a new one.
//!
//! `ssh-keygen -l` gives a key's type, size and fingerprint. A new key is
//! made in this process with the `ssh-key` crate, not with `ssh-keygen -N`:
//! a passphrase on a command line can be read by other users on Linux
//! (`/proc/<pid>/cmdline`).

use serde::Serialize;
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Key {
    /// The private key path: the `.pub` path without `.pub`.
    pub path: String,
    /// False if only the `.pub` file is there.
    pub has_private: bool,
    /// The `.pub` file's line, to copy; empty if there is no `.pub` file.
    pub public: String,
    /// For example `ED25519` or `RSA`. Empty if ssh-keygen could not read it.
    pub kind: String,
    pub bits: u32,
    /// `SHA256:...`, as `ssh -v` and `ssh-add -l` show it.
    pub fingerprint: String,
    pub comment: String,
}

/// Every key in `dir`, sorted by path: each `*.pub` file, and each private
/// key file that has no `.pub` file.
pub fn list(dir: &Path) -> Vec<Key> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    let mut keys: Vec<PathBuf> = files
        .iter()
        .filter_map(|p| {
            if p.extension().is_some_and(|x| x == "pub") {
                Some(p.with_extension(""))
            } else if !pub_path(p).is_file() && is_private_key(p) {
                Some(p.clone())
            } else {
                None
            }
        })
        .collect();
    keys.sort();
    keys.iter().map(|p| read(p)).collect()
}

/// `id_ed25519` gives `id_ed25519.pub`.
fn pub_path(private: &Path) -> PathBuf {
    let mut name = private.as_os_str().to_owned();
    name.push(".pub");
    name.into()
}

/// True if the file starts like a private key (OpenSSH, PEM or PKCS#8).
/// Reads only the first line.
fn is_private_key(path: &Path) -> bool {
    let mut start = [0u8; 64];
    let Ok(n) = fs::File::open(path).and_then(|mut f| f.read(&mut start)) else {
        return false;
    };
    let first = String::from_utf8_lossy(&start[..n]);
    let first = first.lines().next().unwrap_or("");
    first.starts_with("-----BEGIN ") && first.ends_with("PRIVATE KEY-----")
}

/// Read the key at `private` (the `.pub` file if there is one). ssh-keygen
/// can read a private key's details without its passphrase.
fn read(private: &Path) -> Key {
    let public_path = pub_path(private);
    let public = fs::read_to_string(&public_path).unwrap_or_default();
    let source = if public_path.is_file() {
        &public_path
    } else {
        private
    };
    let output = Command::new("ssh-keygen")
        .arg("-l")
        .arg("-f")
        .arg(source)
        .stdin(Stdio::null())
        .output();
    let line = output
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let mut key = parse(&line).unwrap_or_default();
    key.path = private.display().to_string();
    key.has_private = private.is_file();
    key.public = public.trim().to_string();
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
        // What ssh-keygen prints for a key with no comment.
        comment: if comment == "no comment" { "" } else { comment }.to_string(),
        ..Key::default()
    })
}

/// Make a new Ed25519 key `dir/name` and `dir/name.pub`. An empty
/// passphrase leaves the private key unencrypted. Never overwrites a file.
pub fn generate(dir: &Path, name: &str, comment: &str, passphrase: &str) -> Result<Key, String> {
    let valid = !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with(".pub")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if !valid {
        return Err("Use a file name with letters, numbers, dot, dash or underscore, for example id_ed25519_work.".into());
    }
    if comment.contains(['\n', '\r']) {
        return Err("The comment must be on one line.".into());
    }
    let private = dir.join(name);
    let public = pub_path(&private);
    if private.exists() || public.exists() {
        return Err(format!(
            "{} already exists. Choose another name.",
            private.display()
        ));
    }

    use ssh_key::{Algorithm, LineEnding, PrivateKey, rand_core::OsRng};
    let fail = |e: ssh_key::Error| format!("Cannot make the key: {e}");
    let mut key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).map_err(fail)?;
    key.set_comment(comment);
    let public_text = key.public_key().to_openssh().map_err(fail)?;
    if !passphrase.is_empty() {
        key = key.encrypt(&mut OsRng, passphrase).map_err(fail)?;
    }
    let private_text = key.to_openssh(LineEnding::LF).map_err(fail)?;

    let io = |e: std::io::Error| format!("Cannot write the key in {}: {e}", dir.display());
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(io)?;
    // create_new: fails if the file appeared since the check above.
    let write = |path: &Path, mode: u32, text: &str| {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(path)
            .and_then(|mut f| f.write_all(text.as_bytes()))
    };
    write(&private, 0o600, &private_text).map_err(io)?;
    if let Err(e) = write(&public, 0o644, &format!("{public_text}\n")) {
        let _ = fs::remove_file(&private);
        return Err(io(e));
    }
    Ok(read(&private))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ssh-cfg-mgr-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn has_keygen() -> bool {
        Command::new("ssh-keygen")
            .arg("-?")
            .stderr(Stdio::null())
            .status()
            .is_ok()
    }

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
        assert_eq!(
            parse("256 SHA256:x no comment (ED25519)").unwrap().comment,
            ""
        );
    }

    #[test]
    fn lists_real_keys() {
        if !has_keygen() {
            return;
        }
        let dir = temp_dir("keys");
        let made = |name: &str| {
            Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-C", "test key", "-f"])
                .arg(dir.join(name))
                .status()
                .unwrap()
        };
        made("id_test");
        // A private key with no .pub file.
        made("lone");
        fs::remove_file(dir.join("lone.pub")).unwrap();
        fs::write(dir.join("other.pub"), "not a key\n").unwrap();
        fs::write(dir.join("notes"), "-----BEGIN NOTES-----\n").unwrap();
        let keys = list(&dir);
        fs::remove_dir_all(&dir).unwrap();

        let names: Vec<_> = keys
            .iter()
            .map(|k| k.path.rsplit('/').next().unwrap())
            .collect();
        assert_eq!(names, ["id_test", "lone", "other"]);
        let k = &keys[0];
        assert!(k.has_private);
        assert!(k.public.starts_with("ssh-ed25519 ") && k.public.ends_with(" test key"));
        assert_eq!(
            (k.kind.as_str(), k.bits, k.comment.as_str()),
            ("ED25519", 256, "test key")
        );
        assert!(k.fingerprint.starts_with("SHA256:"));
        // Read from the private key: no .pub text to copy.
        assert_eq!(
            (keys[1].kind.as_str(), keys[1].public.as_str()),
            ("ED25519", "")
        );
        // A bad .pub file is still listed, with no details.
        assert_eq!((keys[2].kind.as_str(), keys[2].has_private), ("", false));
    }

    #[test]
    fn generates_keys_that_ssh_keygen_reads() {
        let dir = temp_dir("gen");
        let plain = generate(&dir, "id_plain", "me@test", "").unwrap();
        let locked = generate(&dir, "id_locked", "", "two words").unwrap();
        let mode = |name: &str| fs::metadata(dir.join(name)).unwrap().permissions().mode() & 0o777;
        let modes = (mode("id_plain"), mode("id_plain.pub"));
        let again = generate(&dir, "id_plain", "", "");
        let bad = generate(&dir, "../x", "", "");
        // The passphrase opens the key, so it was encrypted with it.
        let derive = |pass: &str| {
            Command::new("ssh-keygen")
                .args(["-y", "-P", pass, "-f"])
                .arg(dir.join("id_locked"))
                .stdin(Stdio::null())
                .output()
                .map(|o| o.status.success())
        };
        let (right, wrong) = (derive("two words"), derive("wrong"));
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(modes, (0o600, 0o644));
        assert!(again.unwrap_err().contains("already exists"));
        assert!(bad.is_err());
        if has_keygen() {
            assert_eq!(
                (plain.kind.as_str(), plain.comment.as_str()),
                ("ED25519", "me@test")
            );
            assert!(plain.fingerprint.starts_with("SHA256:"));
            assert_eq!(locked.kind, "ED25519");
            assert_eq!((right.unwrap(), wrong.unwrap()), (true, false));
        }
    }
}
