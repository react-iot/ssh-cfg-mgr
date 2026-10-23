//! Lossless parser and editor for OpenSSH client config files (`~/.ssh/config`).
//!
//! "Lossless" means that `SshConfig::parse(text).to_string() == text` for
//! every input: comments, blank lines, indentation, `=` separators, keyword
//! spelling and line endings all stay. An edit changes only the lines it
//! must change.
//!
//! ```
//! use sshconfig_lossless::SshConfig;
//!
//! let mut config = SshConfig::parse("Host gw\n  HostName 10.0.0.1\n");
//! config.host_mut("gw").unwrap().set("User", "admin");
//! assert_eq!(config.to_string(), "Host gw\n  HostName 10.0.0.1\n  User admin\n");
//! ```
//!
//! Limits of this version:
//! - It does not follow `Include` files. They are normal directives here.
//! - It does not calculate the effective settings for a host. Use
//!   `ssh -G <host>` for that; OpenSSH is the reference.

mod line;

pub use line::{Directive, Line, LineKind};

use std::fmt;

const DEFAULT_INDENT: &str = "    ";

/// A `Host` or `Match` line and the lines after it, up to the next block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    header: Line,
    body: Vec<Line>,
}

impl Block {
    fn new(keyword: &str, value: &str) -> Self {
        Block {
            header: Line {
                kind: LineKind::Directive(Directive::new("", keyword, value)),
                eol: "\n".to_string(),
            },
            body: Vec::new(),
        }
    }

    fn header(&self) -> &Directive {
        self.header
            .directive()
            .expect("a block header is always a directive")
    }

    /// True for a `Host` block, false for a `Match` block.
    pub fn is_host(&self) -> bool {
        self.header().is("Host")
    }

    /// The header value as written, for example `gw-* !gw-test`.
    pub fn pattern(&self) -> &str {
        self.header().value()
    }

    /// The header value split into patterns.
    pub fn patterns(&self) -> Vec<String> {
        self.header().args()
    }

    /// All directives in this block, in file order.
    pub fn directives(&self) -> impl Iterator<Item = &Directive> {
        self.body.iter().filter_map(Line::directive)
    }

    /// The value of the first directive with this keyword. OpenSSH uses
    /// the first value it finds, so later duplicates are ignored here too.
    pub fn get(&self, keyword: &str) -> Option<&str> {
        self.directives()
            .find(|d| d.is(keyword))
            .map(Directive::value)
    }

    /// Change the value of `keyword`, or add it if it is not in the block.
    ///
    /// A new line uses the same indent as the other lines in the block, and
    /// goes after the last directive (before trailing comments and blank
    /// lines, which usually belong to the next block).
    pub fn set(&mut self, keyword: &str, value: &str) {
        let existing = self
            .body
            .iter_mut()
            .find_map(|line| line.directive_mut().filter(|d| d.is(keyword)));
        if let Some(directive) = existing {
            directive.set_value(value);
            return;
        }

        let indent = self
            .directives()
            .next()
            .map(|d| d.indent().to_string())
            .unwrap_or_else(|| DEFAULT_INDENT.to_string());
        let eol = self.eol_style();
        let pos = self
            .body
            .iter()
            .rposition(|line| line.directive().is_some())
            .map_or(0, |i| i + 1);

        // If the line before the new one was the last line of the file and
        // had no newline, move the "no newline" to the new line.
        let previous = match pos {
            0 => &mut self.header,
            _ => &mut self.body[pos - 1],
        };
        let new_eol = if previous.eol.is_empty() {
            previous.eol = eol.clone();
            String::new()
        } else {
            eol
        };

        self.body.insert(
            pos,
            Line {
                kind: LineKind::Directive(Directive::new(&indent, keyword, value)),
                eol: new_eol,
            },
        );
    }

    /// Remove every directive with this keyword. Returns how many were removed.
    pub fn remove(&mut self, keyword: &str) -> usize {
        let before = self.body.len();
        self.body
            .retain(|line| !line.directive().is_some_and(|d| d.is(keyword)));
        before - self.body.len()
    }

    /// The line ending this block uses: `\r\n` or `\n`.
    fn eol_style(&self) -> String {
        std::iter::once(&self.header)
            .chain(&self.body)
            .map(|line| line.eol.as_str())
            .find(|eol| !eol.is_empty())
            .unwrap_or("\n")
            .to_string()
    }

    fn last_line_mut(&mut self) -> &mut Line {
        self.body.last_mut().unwrap_or(&mut self.header)
    }
}

impl fmt::Display for Block {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.header)?;
        self.body.iter().try_for_each(|line| write!(f, "{line}"))
    }
}

/// A parsed ssh_config file.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SshConfig {
    /// Lines before the first `Host` or `Match`. They apply to all hosts.
    global: Vec<Line>,
    blocks: Vec<Block>,
}

impl SshConfig {
    /// Parse ssh_config text. This never fails: a line that is not blank
    /// and not a comment is a directive, also if OpenSSH does not know the
    /// keyword. This lets the file round-trip without loss.
    pub fn parse(input: &str) -> Self {
        let mut config = SshConfig::default();

        for piece in input.split_inclusive('\n') {
            let (text, eol) = if let Some(text) = piece.strip_suffix("\r\n") {
                (text, "\r\n")
            } else if let Some(text) = piece.strip_suffix('\n') {
                (text, "\n")
            } else {
                (piece, "")
            };
            let line = Line::parse(text, eol);

            if line.starts_block() {
                config.blocks.push(Block {
                    header: line,
                    body: Vec::new(),
                });
            } else if let Some(block) = config.blocks.last_mut() {
                block.body.push(line);
            } else {
                config.global.push(line);
            }
        }
        config
    }

    /// Directives before the first block.
    pub fn global_directives(&self) -> impl Iterator<Item = &Directive> {
        self.global.iter().filter_map(Line::directive)
    }

    /// All `Host` and `Match` blocks, in file order.
    pub fn blocks(&self) -> &[Block] {
        &self.blocks
    }

    /// All `Host` blocks, in file order.
    pub fn hosts(&self) -> impl Iterator<Item = &Block> {
        self.blocks.iter().filter(|b| b.is_host())
    }

    /// The `Host` block whose pattern text is exactly `pattern`.
    pub fn host(&self, pattern: &str) -> Option<&Block> {
        self.hosts().find(|b| b.pattern() == pattern)
    }

    pub fn host_mut(&mut self, pattern: &str) -> Option<&mut Block> {
        self.blocks
            .iter_mut()
            .find(|b| b.is_host() && b.pattern() == pattern)
    }

    /// Add a new `Host` block at the end of the file, after one blank line.
    pub fn add_host(&mut self, pattern: &str) -> &mut Block {
        let last = match self.blocks.last_mut() {
            Some(block) => Some(block.last_line_mut()),
            None => self.global.last_mut(),
        };
        if let Some(last) = last {
            if last.eol.is_empty() {
                last.eol = "\n".to_string();
            }
            if !last.is_blank() {
                let blank = Line::blank("\n");
                match self.blocks.last_mut() {
                    Some(block) => block.body.push(blank),
                    None => self.global.push(blank),
                }
            }
        }

        self.blocks.push(Block::new("Host", pattern));
        self.blocks.last_mut().expect("block was just added")
    }

    /// Remove the `Host` block whose pattern text is exactly `pattern`.
    /// Returns false if there is no such block.
    ///
    /// Comments above a `Host` line are part of the previous block in this
    /// model, so they stay.
    pub fn remove_host(&mut self, pattern: &str) -> bool {
        match self
            .blocks
            .iter()
            .position(|b| b.is_host() && b.pattern() == pattern)
        {
            Some(index) => {
                self.blocks.remove(index);
                true
            }
            None => false,
        }
    }
}

impl fmt::Display for SshConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.global
            .iter()
            .try_for_each(|line| write!(f, "{line}"))?;
        self.blocks
            .iter()
            .try_for_each(|block| write!(f, "{block}"))
    }
}
