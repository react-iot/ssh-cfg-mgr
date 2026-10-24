//! One line of an ssh_config file.
//!
//! Each line keeps every byte of its original text, so that writing the
//! file back gives exactly the same output as the input.

use std::fmt;

/// A `Keyword value` line, split into parts.
///
/// `indent + keyword + separator + value + trailing` is the original text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Directive {
    indent: String,
    keyword: String,
    /// The text between keyword and value: spaces, tabs and/or one `=`.
    separator: String,
    value: String,
    /// Whitespace after the value.
    trailing: String,
}

impl Directive {
    pub(crate) fn new(indent: &str, keyword: &str, value: &str) -> Self {
        Directive {
            indent: indent.to_string(),
            keyword: keyword.to_string(),
            separator: " ".to_string(),
            value: value.to_string(),
            trailing: String::new(),
        }
    }

    /// The keyword as written in the file, for example `HostName`.
    pub fn keyword(&self) -> &str {
        &self.keyword
    }

    /// The raw value text, with quotes kept.
    pub fn value(&self) -> &str {
        &self.value
    }

    pub fn indent(&self) -> &str {
        &self.indent
    }

    /// True if this line has the given keyword. OpenSSH keywords are
    /// not case-sensitive, so `hostname` matches `HostName`.
    pub fn is(&self, keyword: &str) -> bool {
        self.keyword.eq_ignore_ascii_case(keyword)
    }

    /// Change the value. The indent, keyword spelling and separator stay.
    pub fn set_value(&mut self, value: &str) {
        if self.separator.is_empty() {
            self.separator = " ".to_string();
        }
        self.value = value.to_string();
    }

    /// The value split into arguments. Double quotes group words that
    /// contain spaces: `"My Key" other` gives `["My Key", "other"]`.
    pub fn args(&self) -> Vec<String> {
        let mut args = Vec::new();
        let mut current = String::new();
        let mut in_quotes = false;
        let mut has_arg = false;

        for c in self.value.chars() {
            match c {
                '"' => {
                    in_quotes = !in_quotes;
                    has_arg = true;
                }
                c if c.is_whitespace() && !in_quotes => {
                    if has_arg {
                        args.push(std::mem::take(&mut current));
                        has_arg = false;
                    }
                }
                c => {
                    current.push(c);
                    has_arg = true;
                }
            }
        }
        if has_arg {
            args.push(current);
        }
        args
    }

    fn parse(text: &str) -> Self {
        let rest = text.trim_start();
        let indent = &text[..text.len() - rest.len()];

        let keyword_len = rest
            .find(|c: char| c.is_whitespace() || c == '=')
            .unwrap_or(rest.len());
        let (keyword, rest) = rest.split_at(keyword_len);

        // The separator is whitespace, then an optional `=`, then whitespace.
        let mut value_start = rest.trim_start();
        if let Some(after_eq) = value_start.strip_prefix('=') {
            value_start = after_eq.trim_start();
        }
        let (separator, rest) = rest.split_at(rest.len() - value_start.len());

        let value = rest.trim_end();
        let trailing = &rest[value.len()..];

        Directive {
            indent: indent.to_string(),
            keyword: keyword.to_string(),
            separator: separator.to_string(),
            value: value.to_string(),
            trailing: trailing.to_string(),
        }
    }
}

impl fmt::Display for Directive {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}{}{}{}{}",
            self.indent, self.keyword, self.separator, self.value, self.trailing
        )
    }
}

/// What a line contains.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineKind {
    /// An empty line, or a line that has only whitespace.
    Blank(String),
    /// A line that starts with `#` (after optional whitespace).
    Comment(String),
    Directive(Directive),
}

/// One line, plus its line ending (`"\n"`, `"\r\n"`, or `""` for a last
/// line that has no newline).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub kind: LineKind,
    pub(crate) eol: String,
}

impl Line {
    pub(crate) fn parse(text: &str, eol: &str) -> Self {
        let trimmed = text.trim_start();
        let kind = if trimmed.is_empty() {
            LineKind::Blank(text.to_string())
        } else if trimmed.starts_with('#') {
            LineKind::Comment(text.to_string())
        } else {
            LineKind::Directive(Directive::parse(text))
        };
        Line {
            kind,
            eol: eol.to_string(),
        }
    }

    pub(crate) fn blank(eol: &str) -> Self {
        Line {
            kind: LineKind::Blank(String::new()),
            eol: eol.to_string(),
        }
    }

    pub fn directive(&self) -> Option<&Directive> {
        match &self.kind {
            LineKind::Directive(d) => Some(d),
            _ => None,
        }
    }

    pub fn directive_mut(&mut self) -> Option<&mut Directive> {
        match &mut self.kind {
            LineKind::Directive(d) => Some(d),
            _ => None,
        }
    }

    pub fn is_blank(&self) -> bool {
        matches!(self.kind, LineKind::Blank(_))
    }

    pub fn is_comment(&self) -> bool {
        matches!(self.kind, LineKind::Comment(_))
    }

    /// True for `Host` and `Match` lines, which start a new block.
    pub(crate) fn starts_block(&self) -> bool {
        self.directive()
            .is_some_and(|d| d.is("Host") || d.is("Match"))
    }
}

impl fmt::Display for Line {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.kind {
            LineKind::Blank(text) | LineKind::Comment(text) => f.write_str(text)?,
            LineKind::Directive(d) => write!(f, "{d}")?,
        }
        f.write_str(&self.eol)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Directive {
        Directive::parse(text)
    }

    #[test]
    fn splits_directive_parts() {
        let d = parse("  HostName = example.com  ");
        assert_eq!(d.indent(), "  ");
        assert_eq!(d.keyword(), "HostName");
        assert_eq!(d.value(), "example.com");
        assert_eq!(d.to_string(), "  HostName = example.com  ");
    }

    #[test]
    fn accepts_equals_without_spaces() {
        let d = parse("Port=2222");
        assert_eq!(d.keyword(), "Port");
        assert_eq!(d.value(), "2222");
        assert_eq!(d.to_string(), "Port=2222");
    }

    #[test]
    fn splits_quoted_args() {
        let d = parse(r#"IdentityFile "~/.ssh/my key" ~/.ssh/other"#);
        assert_eq!(d.args(), vec!["~/.ssh/my key", "~/.ssh/other"]);
    }

    #[test]
    fn keyword_match_ignores_case() {
        assert!(parse("hostname x").is("HostName"));
    }
}
