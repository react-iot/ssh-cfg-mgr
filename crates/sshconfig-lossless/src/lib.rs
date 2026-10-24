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
    fn new(keyword: &str, value: &str, eol: &str) -> Self {
        Block {
            header: Line {
                kind: LineKind::Directive(Directive::new("", keyword, value)),
                eol: eol.to_string(),
            },
            body: Vec::new(),
        }
    }

    fn header_mut(&mut self) -> &mut Directive {
        self.header
            .directive_mut()
            .expect("a block header is always a directive")
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

    /// Change the header value, for example from `gw-*` to `gw-* !gw-test`.
    pub fn set_pattern(&mut self, pattern: &str) {
        self.header_mut().set_value(pattern);
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
        let pos = self.default_insert_pos();
        self.insert_directive(pos, keyword, value);
    }

    /// Make `keyword` have exactly these values, in this order. Use this for
    /// keywords that can repeat, such as `IdentityFile` or `LocalForward`.
    ///
    /// Existing lines are changed in place. Extra lines are removed. New
    /// values go after the last existing line with this keyword. An empty
    /// `values` removes the keyword.
    pub fn set_all(&mut self, keyword: &str, values: &[&str]) {
        let positions = self.positions(keyword);

        for (&pos, value) in positions.iter().zip(values) {
            if let Some(directive) = self.body[pos].directive_mut() {
                directive.set_value(value);
            }
        }

        // Remove from the end, so that the earlier positions stay correct.
        for &pos in positions.iter().skip(values.len()).rev() {
            self.remove_line(pos);
        }

        let start = match positions.last() {
            Some(&last) => last + 1,
            None => self.default_insert_pos(),
        };
        for (pos, value) in (start..).zip(values.iter().skip(positions.len())) {
            self.insert_directive(pos, keyword, value);
        }
    }

    /// Remove every directive with this keyword. Returns how many were removed.
    pub fn remove(&mut self, keyword: &str) -> usize {
        let positions = self.positions(keyword);
        for &pos in positions.iter().rev() {
            self.remove_line(pos);
        }
        positions.len()
    }

    /// Indexes in `body` of the directives with this keyword.
    fn positions(&self, keyword: &str) -> Vec<usize> {
        self.body
            .iter()
            .enumerate()
            .filter(|(_, line)| line.directive().is_some_and(|d| d.is(keyword)))
            .map(|(i, _)| i)
            .collect()
    }

    /// After the last directive: before trailing comments and blank lines,
    /// which usually belong to the next block.
    fn default_insert_pos(&self) -> usize {
        self.body
            .iter()
            .rposition(|line| line.directive().is_some())
            .map_or(0, |i| i + 1)
    }

    /// Insert a new directive line. It uses the same indent as the other
    /// lines in the block.
    fn insert_directive(&mut self, pos: usize, keyword: &str, value: &str) {
        let indent = self
            .directives()
            .next()
            .map(|d| d.indent().to_string())
            .unwrap_or_else(|| DEFAULT_INDENT.to_string());
        let eol = self.eol_style();

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

    fn remove_line(&mut self, pos: usize) {
        let removed = self.body.remove(pos);
        // Only the last line of a file can have no newline. Keep it that way.
        if removed.eol.is_empty() {
            let previous = match pos {
                0 => &mut self.header,
                _ => &mut self.body[pos - 1],
            };
            previous.eol.clear();
        }
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

    /// The block at `index` in [`SshConfig::blocks`].
    pub fn block_mut(&mut self, index: usize) -> Option<&mut Block> {
        self.blocks.get_mut(index)
    }

    /// Add a new `Host` block at the end of the file, after one blank line.
    pub fn add_host(&mut self, pattern: &str) -> &mut Block {
        let eol = self.eol_style();
        if let Some(last) = self.last_line_mut() {
            if last.eol.is_empty() {
                last.eol = eol.clone();
            }
            if !last.is_blank() {
                self.lines_before_mut(self.blocks.len())
                    .push(Line::blank(&eol));
            }
        }

        self.blocks.push(Block::new("Host", pattern, &eol));
        self.blocks.last_mut().expect("block was just added")
    }

    /// Add a new `Host` block before the block at `index`. If `index` is
    /// past the end, this is the same as [`SshConfig::add_host`].
    ///
    /// Use this to add a host before a `Host *` block. OpenSSH uses the
    /// first value it finds, so the defaults in `Host *` must come last.
    ///
    /// Comments directly above the block at `index` describe that block, so
    /// they stay above it, after the new host.
    pub fn insert_host(&mut self, index: usize, pattern: &str) -> &mut Block {
        if index >= self.blocks.len() {
            return self.add_host(pattern);
        }
        let eol = self.eol_style();

        let before = self.lines_before_mut(index);
        let comments = take_comment_suffix(before);
        if before.last().is_some_and(|line| !line.is_blank()) {
            before.push(Line::blank(&eol));
        }

        let mut block = Block::new("Host", pattern, &eol);
        block.body.push(Line::blank(&eol));
        block.body.extend(comments);
        self.blocks.insert(index, block);
        &mut self.blocks[index]
    }

    /// Remove the block at `index` and return it.
    ///
    /// Comments directly above the block are removed with it, because they
    /// describe it. Comments at the end of the block stay, because they
    /// describe the next block.
    pub fn remove_block(&mut self, index: usize) -> Option<Block> {
        if index >= self.blocks.len() {
            return None;
        }
        let mut removed = self.blocks.remove(index);
        let was_last = index == self.blocks.len();
        let ended_without_newline = removed.last_line_mut().eol.is_empty();

        let keep = take_comment_suffix(&mut removed.body);
        let before = self.lines_before_mut(index);
        take_comment_suffix(before);
        before.extend(keep);

        if was_last
            && ended_without_newline
            && let Some(last) = self.last_line_mut()
        {
            last.eol.clear();
        }
        Some(removed)
    }

    /// Remove the first `Host` block whose pattern text is exactly
    /// `pattern`. Returns false if there is no such block.
    pub fn remove_host(&mut self, pattern: &str) -> bool {
        let index = self
            .blocks
            .iter()
            .position(|b| b.is_host() && b.pattern() == pattern);
        index.and_then(|i| self.remove_block(i)).is_some()
    }

    /// The line ending this file uses: `\r\n` or `\n`.
    fn eol_style(&self) -> String {
        self.global
            .iter()
            .chain(
                self.blocks
                    .iter()
                    .flat_map(|b| std::iter::once(&b.header).chain(&b.body)),
            )
            .map(|line| line.eol.as_str())
            .find(|eol| !eol.is_empty())
            .unwrap_or("\n")
            .to_string()
    }

    fn last_line_mut(&mut self) -> Option<&mut Line> {
        match self.blocks.last_mut() {
            Some(block) => Some(block.last_line_mut()),
            None => self.global.last_mut(),
        }
    }

    /// The lines just before the block at `index`: the global lines for the
    /// first block, otherwise the body of the block before it.
    fn lines_before_mut(&mut self, index: usize) -> &mut Vec<Line> {
        match index {
            0 => &mut self.global,
            _ => &mut self.blocks[index - 1].body,
        }
    }
}

/// Remove the comment lines at the end of `lines` and return them.
fn take_comment_suffix(lines: &mut Vec<Line>) -> Vec<Line> {
    let count = lines.iter().rev().take_while(|l| l.is_comment()).count();
    lines.split_off(lines.len() - count)
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
