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

pub use line::{Directive, Line, LineKind, OFF_PREFIX};

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
            header: Line::new(LineKind::Directive(Directive::new("", keyword, value)), eol),
            body: Vec::new(),
        }
    }

    /// False if the block is turned off: each of its lines starts with
    /// [`OFF_PREFIX`], so OpenSSH ignores it.
    pub fn is_enabled(&self) -> bool {
        !self.header.off
    }

    /// Turn the block on or off. Off adds [`OFF_PREFIX`] to the header and
    /// to each directive; on removes it from every line. Blank lines and
    /// comments stay as they are, so turning a block off and on again gives
    /// the same text.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.header.off = !enabled;
        for line in &mut self.body {
            if enabled {
                line.off = false;
            } else if line.directive().is_some() {
                line.off = true;
            }
        }
    }

    /// A line is part of the block if it is on or off the same as the
    /// header. OpenSSH ignores a `#~` line in an enabled block, so we do too.
    fn is_live(&self, line: &Line) -> bool {
        line.off == self.header.off
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
        self.body
            .iter()
            .filter(|line| self.is_live(line))
            .filter_map(Line::directive)
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
            .filter(|(_, line)| {
                self.is_live(line) && line.directive().is_some_and(|d| d.is(keyword))
            })
            .map(|(i, _)| i)
            .collect()
    }

    /// After the last directive: before trailing comments and blank lines,
    /// which usually belong to the next block.
    fn default_insert_pos(&self) -> usize {
        self.body
            .iter()
            .rposition(|line| self.is_live(line) && line.directive().is_some())
            .map_or(0, |i| i + 1)
    }

    /// Insert a new directive line. It uses the same indent as the other
    /// lines in the block.
    fn insert_directive(&mut self, pos: usize, keyword: &str, value: &str) {
        let indent = self
            .directives()
            .next()
            .map(|d| d.indent().to_string())
            .unwrap_or_else(|| self.default_indent().to_string());
        let eol = self.eol_style();
        let off = self.header.off;

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

        let mut line = Line::new(
            LineKind::Directive(Directive::new(&indent, keyword, value)),
            &new_eol,
        );
        line.off = off;
        self.body.insert(pos, line);
    }

    /// Lines in a block are indented; lines before the first block (see
    /// [`SshConfig::edit_global`], whose header has no keyword) are not.
    fn default_indent(&self) -> &'static str {
        if self.header().keyword().is_empty() {
            ""
        } else {
            DEFAULT_INDENT
        }
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

    /// How many body lines belong to the block itself: up to its last
    /// directive. Blank lines and comments after that separate it from, or
    /// describe, the next block.
    fn own_len(&self) -> usize {
        self.body
            .iter()
            .rposition(|line| line.directive().is_some())
            .map_or(0, |i| i + 1)
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
        self.global
            .iter()
            .filter(|line| !line.off)
            .filter_map(Line::directive)
    }

    /// Edit the lines before the first block with the [`Block`] methods
    /// (`set`, `set_all`, `remove`). `f` gets a block with no header; it is
    /// never written. New lines have no indent and use the file's line
    /// ending.
    ///
    /// ```
    /// use sshconfig_lossless::SshConfig;
    ///
    /// let mut config = SshConfig::parse("Host a\n");
    /// config.edit_global(|g| g.set("AddKeysToAgent", "yes"));
    /// assert_eq!(config.to_string(), "AddKeysToAgent yes\nHost a\n");
    /// ```
    pub fn edit_global<R>(&mut self, f: impl FnOnce(&mut Block) -> R) -> R {
        let header = Line::new(
            LineKind::Directive(Directive::new("", "", "")),
            &self.eol_style(),
        );
        let mut global = Block {
            header,
            body: std::mem::take(&mut self.global),
        };
        let result = f(&mut global);
        self.global = global.body;
        result
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

    /// The comment lines directly above the block at `index`, as written
    /// (with `#` and indent). These are the comments that move and are
    /// deleted with the block.
    pub fn comments_above(&self, index: usize) -> Vec<&str> {
        if index >= self.blocks.len() {
            return Vec::new();
        }
        let lines = match index {
            0 => &self.global,
            _ => &self.blocks[index - 1].body,
        };
        lines[lines.len() - comment_suffix_len(lines)..]
            .iter()
            .filter_map(|line| match &line.kind {
                LineKind::Comment(text) => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Change one comment line directly above the block at `index`: the
    /// first one for which `is_match` is true. `Some(text)` replaces it, or
    /// adds `text` as the last line above the block if none matches.
    /// `None` removes it. Returns false if there is no block at `index`.
    ///
    /// # Panics
    ///
    /// If `text` is not one comment line (it must start with `#` and have
    /// no line break). Anything else would change the config.
    pub fn set_comment_above(
        &mut self,
        index: usize,
        is_match: impl Fn(&str) -> bool,
        text: Option<&str>,
    ) -> bool {
        if let Some(text) = text {
            assert!(
                text.trim_start().starts_with('#') && !text.contains(['\n', '\r']),
                "not one comment line: {text:?}"
            );
        }
        if index >= self.blocks.len() {
            return false;
        }
        let eol = self.eol_style();
        let lines = self.lines_before_mut(index);
        let start = lines.len() - comment_suffix_len(lines);
        let found = (start..lines.len())
            .find(|&i| matches!(&lines[i].kind, LineKind::Comment(t) if is_match(t)));
        // A line above a block always ends with a newline, because the block
        // header comes after it.
        match (found, text) {
            (Some(i), Some(text)) => lines[i].kind = LineKind::Comment(text.to_string()),
            (Some(i), None) => {
                lines.remove(i);
            }
            (None, Some(text)) => lines.push(Line::new(LineKind::Comment(text.to_string()), &eol)),
            (None, None) => {}
        }
        true
    }

    /// Move the block at `from` so that it ends up at `to` (an index in the
    /// new order). Returns false if either index is out of range.
    ///
    /// The comments directly above the block move with it. The spacing it
    /// leaves is closed up, and the comments above the block it is put in
    /// front of stay with that block, as in [`SshConfig::insert_host`].
    ///
    /// OpenSSH uses the first value it finds, so this can change which
    /// settings apply.
    pub fn move_block(&mut self, from: usize, to: usize) -> bool {
        let len = self.blocks.len();
        if from >= len || to >= len {
            return false;
        }
        if from == to {
            return true;
        }
        let eol = self.eol_style();
        let ended_without_newline = self.last_line_mut().is_some_and(|l| l.eol.is_empty());

        // Take the block and its comments; leave what followed it in place.
        let comments = take_comment_suffix(self.lines_before_mut(from));
        let mut block = self.blocks.remove(from);
        let after = block.body.split_off(block.own_len());
        let before = self.lines_before_mut(from);
        while before.last().is_some_and(Line::is_blank) {
            before.pop();
        }
        before.extend(after);

        // Put it in front of the block now at `to` (or at the end).
        let before = self.lines_before_mut(to);
        let displaced = take_comment_suffix(before);
        if before.last().is_some_and(|line| !line.is_blank()) {
            before.push(Line::blank(&eol));
        }
        before.extend(comments);
        if to < self.blocks.len() || !displaced.is_empty() {
            block.body.push(Line::blank(&eol));
        }
        block.body.extend(displaced);
        self.blocks.insert(to, block);

        // Only the last line of a file may have no newline.
        for line in self.lines_mut() {
            if line.eol.is_empty() {
                line.eol.clone_from(&eol);
            }
        }
        if ended_without_newline && let Some(last) = self.last_line_mut() {
            last.eol.clear();
        }
        true
    }

    /// Move one line before the first block: the directive at `from` in
    /// [`SshConfig::global_directives`] order ends up at `to` in that order.
    /// Other lines (comments, blank lines) stay where they are. Returns false
    /// if either index is out of range.
    ///
    /// Use this to reorder `Include` lines: OpenSSH reads them in file order.
    pub fn move_global_directive(&mut self, from: usize, to: usize) -> bool {
        let positions = |lines: &[Line]| -> Vec<usize> {
            lines
                .iter()
                .enumerate()
                .filter(|(_, line)| !line.off && line.directive().is_some())
                .map(|(i, _)| i)
                .collect()
        };
        let before = positions(&self.global);
        if from >= before.len() || to >= before.len() {
            return false;
        }
        if from == to {
            return true;
        }
        let eol = self.eol_style();
        let ended_without_newline = self.last_line_mut().is_some_and(|l| l.eol.is_empty());

        let line = self.global.remove(before[from]);
        let after = positions(&self.global);
        let at = match after.get(to) {
            Some(&i) => i,
            None => after.last().map_or(0, |&i| i + 1),
        };
        self.global.insert(at, line);

        // Only the last line of a file may have no newline.
        for line in self.lines_mut() {
            if line.eol.is_empty() {
                line.eol.clone_from(&eol);
            }
        }
        if ended_without_newline && let Some(last) = self.last_line_mut() {
            last.eol.clear();
        }
        true
    }

    fn lines_mut(&mut self) -> impl Iterator<Item = &mut Line> {
        self.global.iter_mut().chain(
            self.blocks
                .iter_mut()
                .flat_map(|b| std::iter::once(&mut b.header).chain(b.body.iter_mut())),
        )
    }

    /// The text of the block at `index`, as written: its header and its
    /// lines up to the last directive. The blank lines and comments after
    /// that are not part of it (see [`SshConfig::set_block_text`]).
    pub fn block_text(&self, index: usize) -> Option<String> {
        let block = self.blocks.get(index)?;
        let own = &block.body[..block.own_len()];
        Some(
            std::iter::once(&block.header)
                .chain(own)
                .map(Line::to_string)
                .collect(),
        )
    }

    /// Replace the lines of the block at `index` (see
    /// [`SshConfig::block_text`]) with `text`. `text` must be exactly one
    /// `Host` or `Match` block. Its line endings change to the file's. The
    /// blank lines and comments after the block, and every other line in the
    /// file, stay as they are.
    pub fn set_block_text(&mut self, index: usize, text: &str) -> Result<(), String> {
        if index >= self.blocks.len() {
            return Err(format!("There is no block {index}."));
        }
        let parsed = SshConfig::parse(text);
        if parsed.global.iter().any(|line| !line.is_blank()) {
            return Err("The text must start with a Host or Match line.".into());
        }
        let [mut new] = <[Block; 1]>::try_from(parsed.blocks)
            .map_err(|_| "The text must have exactly one Host or Match block.".to_string())?;
        // Spacing after the block stays as it is in the file.
        while new.body.last().is_some_and(Line::is_blank) {
            new.body.pop();
        }

        let eol = self.eol_style();
        let old = &mut self.blocks[index];
        let after = old.body.split_off(old.own_len());
        // Only the last line of a file may have no newline. Keep it that way.
        let ends_file = after.is_empty() && old.last_line_mut().eol.is_empty();
        for line in std::iter::once(&mut new.header).chain(&mut new.body) {
            line.eol.clone_from(&eol);
        }
        if ends_file {
            new.last_line_mut().eol.clear();
        }
        new.body.extend(after);
        *old = new;
        Ok(())
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
    let count = comment_suffix_len(lines);
    lines.split_off(lines.len() - count)
}

/// How many comment lines are at the end of `lines`.
fn comment_suffix_len(lines: &[Line]) -> usize {
    lines.iter().rev().take_while(|l| l.is_comment()).count()
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
