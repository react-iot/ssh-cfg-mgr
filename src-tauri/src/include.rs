//! Find the files that `Include` lines bring in, so the UI can show their
//! hosts (read-only for now).
//!
//! Rules from man ssh_config (OpenSSH 10.3), "Include": several paths per
//! line; glob(7) wildcards, expanded in lexical order; environment variables;
//! `~` for the home folder; relative paths are in `~/.ssh` for a user
//! config. An Include inside a Host or Match block applies only there.
//! Tokens such as `%h` depend on the host being connected to, so a path with
//! one (other than `%d` and `%%`) cannot be listed; it is reported instead.

use glob::MatchOptions;
use serde::Serialize;
use sshconfig_lossless::SshConfig;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Included files can include more. Stop here (and at loops).
const MAX_DEPTH: usize = 16;

/// One file brought in by an Include line.
#[derive(Serialize)]
pub struct IncludedFile {
    /// The file, with the home folder written as `~`.
    pub path: String,
    /// The Include line's value, for example `config.d/*`.
    pub pattern: String,
    /// The file that has the Include line.
    pub from: String,
    /// `Host x` or `Match ...` if the Include is inside a block.
    pub condition: Option<String>,
    /// The parsed file. None if it could not be read.
    #[serde(skip)]
    pub config: Option<SshConfig>,
    pub error: Option<String>,
}

/// Every file included from the config at `path`, in the order ssh reads
/// them. `home` is the home folder.
pub fn resolve(path: &Path, config: &SshConfig, home: &Path) -> Vec<IncludedFile> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    seen.insert(path.canonicalize().unwrap_or_else(|_| path.to_path_buf()));
    walk(path, config, home, 1, &mut seen, &mut found);
    found
}

fn walk(
    path: &Path,
    config: &SshConfig,
    home: &Path,
    depth: usize,
    seen: &mut HashSet<PathBuf>,
    found: &mut Vec<IncludedFile>,
) {
    // Includes before the first block, then inside each block.
    let mut lines: Vec<(Vec<String>, String, Option<String>)> = config
        .global_directives()
        .filter(|d| d.is("Include"))
        .map(|d| (d.args(), d.value().to_string(), None))
        .collect();
    for block in config.blocks().iter().filter(|b| b.is_enabled()) {
        let kind = if block.is_host() { "Host" } else { "Match" };
        let condition = format!("{kind} {}", block.pattern());
        for d in block.directives().filter(|d| d.is("Include")) {
            lines.push((d.args(), d.value().to_string(), Some(condition.clone())));
        }
    }

    for (args, pattern, condition) in lines {
        for arg in args {
            let entry = |file: String, config, error| IncludedFile {
                path: file,
                pattern: pattern.clone(),
                from: tilde(path, home),
                condition: condition.clone(),
                config,
                error,
            };
            let files = match expand(&arg, home) {
                Ok(files) => files,
                Err(error) => {
                    found.push(entry(arg.clone(), None, Some(error)));
                    continue;
                }
            };
            for file in files {
                let key = file.canonicalize().unwrap_or_else(|_| file.clone());
                if !seen.insert(key) {
                    continue; // Already listed, or a loop.
                }
                match fs::read_to_string(&file) {
                    Ok(text) => {
                        let included = SshConfig::parse(&text);
                        let index = found.len();
                        found.push(entry(tilde(&file, home), None, None));
                        if depth < MAX_DEPTH {
                            walk(&file, &included, home, depth + 1, seen, found);
                        }
                        found[index].config = Some(included);
                    }
                    Err(e) => found.push(entry(
                        tilde(&file, home),
                        None,
                        Some(format!("Cannot read it: {e}")),
                    )),
                }
            }
        }
    }
}

/// The files one Include path names, in lexical order. A path with no
/// matching file gives none, as in ssh.
fn expand(arg: &str, home: &Path) -> Result<Vec<PathBuf>, String> {
    let mut text = String::new();
    let mut rest = arg;
    // %d is the home folder and %% a percent sign; other tokens depend on
    // the host, so there is no single file to list.
    while let Some(i) = rest.find('%') {
        text.push_str(&rest[..i]);
        match rest[i + 1..].chars().next() {
            Some('d') => text.push_str(&home.to_string_lossy()),
            Some('%') => text.push('%'),
            Some(c) => {
                return Err(format!(
                    "Uses %{c}, which depends on the host, so its files cannot be listed."
                ));
            }
            None => return Err("Ends with a lone %.".into()),
        }
        rest = &rest[i + 2..];
    }
    text.push_str(rest);
    let text = env_vars(&text)?;

    let path = if text == "~" {
        home.to_path_buf()
    } else if let Some(rest) = text.strip_prefix("~/") {
        home.join(rest)
    } else if text.starts_with('~') {
        return Err("~user paths are not supported here.".into());
    } else if Path::new(&text).is_absolute() {
        PathBuf::from(&text)
    } else {
        home.join(".ssh").join(&text)
    };

    let options = MatchOptions {
        case_sensitive: true,
        require_literal_separator: true,
        // As glob(3): * does not match a leading dot.
        require_literal_leading_dot: true,
    };
    let pattern = path.to_string_lossy();
    let paths =
        glob::glob_with(&pattern, options).map_err(|e| format!("Not a valid pattern: {e}"))?;
    Ok(paths
        .filter_map(Result::ok)
        .filter(|p| p.is_file())
        .collect())
}

/// Replace `${NAME}` with the environment variable's value.
fn env_vars(text: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let end = rest[i..].find('}').ok_or("An ${ has no closing }.")? + i;
        let name = &rest[i + 2..end];
        out.push_str(
            &std::env::var(name)
                .map_err(|_| format!("The environment variable {name} is not set."))?,
        );
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// `path` with the home folder written as `~`.
fn tilde(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if !home.as_os_str().is_empty() => format!("~/{}", rest.display()),
        _ => path.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake home folder with ~/.ssh in it.
    fn home(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ssh-cfg-mgr-inc-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".ssh/config.d")).unwrap();
        dir
    }

    fn paths(found: &[IncludedFile]) -> Vec<&str> {
        found.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn relative_glob_is_in_ssh_folder_in_lexical_order() {
        let home = home("glob");
        for name in ["b.conf", "a.conf", ".hidden.conf", "notes.txt"] {
            fs::write(home.join(".ssh/config.d").join(name), "Host x\n").unwrap();
        }
        let main = home.join(".ssh/config");
        let config = SshConfig::parse("Include config.d/*.conf\nHost a\n");
        let found = resolve(&main, &config, &home);
        assert_eq!(
            paths(&found),
            ["~/.ssh/config.d/a.conf", "~/.ssh/config.d/b.conf"]
        );
        assert_eq!(found[0].from, "~/.ssh/config");
        assert_eq!(found[0].pattern, "config.d/*.conf");
        assert!(found[0].condition.is_none());
    }

    #[test]
    fn nested_conditional_tilde_and_loops() {
        let home = home("nested");
        let ssh = home.join(".ssh");
        fs::write(ssh.join("one"), "Include ~/.ssh/two\nHost one\n").unwrap();
        // two includes one again: a loop, listed once.
        fs::write(ssh.join("two"), "Include one\nHost two\n").unwrap();
        fs::write(ssh.join("work"), "Host w\n").unwrap();
        let config = SshConfig::parse("Include one\nHost main\n    Include %d/.ssh/work\n");
        let found = resolve(&ssh.join("config"), &config, &home);
        assert_eq!(paths(&found), ["~/.ssh/one", "~/.ssh/two", "~/.ssh/work"]);
        assert_eq!(found[1].from, "~/.ssh/one");
        assert_eq!(found[2].condition.as_deref(), Some("Host main"));
        assert_eq!(found[2].config.as_ref().unwrap().blocks()[0].pattern(), "w");
    }

    #[test]
    fn host_tokens_and_missing_files() {
        let home = home("tokens");
        let config = SshConfig::parse("Include config.d/%h.conf config.d/none-*\n");
        let found = resolve(&home.join(".ssh/config"), &config, &home);
        assert_eq!(
            found.len(),
            1,
            "a glob with no match lists nothing, like ssh"
        );
        assert!(found[0].error.as_deref().unwrap().contains("%h"));
    }
}
