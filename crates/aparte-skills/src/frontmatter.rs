//! The YAML frontmatter of a `SKILL.md`: the block between a first line `---` and the next `---`.
//!
//! Skills use a small part of YAML, and this module reads exactly that part instead of pulling in a YAML library:
//! mappings by indentation, plain, single-quoted and double-quoted scalars, literal (`|`) and folded (`>`) block
//! scalars with their chomping indicators, block lists (`- item`), flow lists (`[a, b]`) and comments. Anchors,
//! tags, multi-document streams and flow mappings are not read (a flow mapping is kept as its raw text).

use std::fmt;

/// A YAML value of the supported subset. Scalars stay strings; [`Value::as_bool`] reads booleans.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Null,
    Str(String),
    List(Vec<Value>),
    Map(Vec<(String, Value)>),
}

impl Value {
    /// The scalar, if this is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    /// `true`/`false` (and the YAML 1.1 spellings `yes`/`no`, `on`/`off`), case-insensitively.
    pub fn as_bool(&self) -> Option<bool> {
        match self.as_str()?.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" => Some(true),
            "false" | "no" | "off" => Some(false),
            _ => None,
        }
    }

    /// A key of a mapping.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Map(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

/// Why a frontmatter could not be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub struct YamlError {
    /// 1-based line in the frontmatter.
    pub line: usize,
    pub message: String,
}

impl fmt::Display for YamlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "frontmatter line {}: {}", self.line, self.message)
    }
}

/// Splits a document into its frontmatter (without the `---` lines) and its body. `None` when the document does
/// not start with a frontmatter block.
pub fn split(doc: &str) -> Option<(&str, &str)> {
    let doc = doc.strip_prefix('\u{feff}').unwrap_or(doc);
    let first_end = doc.find('\n')?;
    if doc[..first_end].trim_end() != "---" {
        return None;
    }
    let rest = &doc[first_end + 1..];
    let mut at = 0;
    for line in rest.split_inclusive('\n') {
        let t = line.trim_end();
        if t == "---" || t == "..." {
            return Some((&rest[..at], &rest[at + line.len()..]));
        }
        at += line.len();
    }
    None
}

struct Line<'a> {
    no: usize,
    indent: usize,
    text: &'a str,
}

fn err(line: usize, message: impl Into<String>) -> YamlError {
    YamlError {
        line,
        message: message.into(),
    }
}

/// Parses a frontmatter into a mapping.
pub fn parse(src: &str) -> Result<Value, YamlError> {
    let raw: Vec<&str> = src.lines().collect();
    let mut p = Parser { raw, pos: 0 };
    p.skip_blank();
    if p.pos >= p.raw.len() {
        return Ok(Value::Map(Vec::new()));
    }
    let indent = p.line(p.pos).indent;
    let v = p.map(indent)?;
    p.skip_blank();
    if p.pos < p.raw.len() {
        let l = p.line(p.pos);
        return Err(err(l.no, "unexpected indentation"));
    }
    Ok(v)
}

struct Parser<'a> {
    raw: Vec<&'a str>,
    pos: usize,
}

fn is_blank(s: &str) -> bool {
    let t = s.trim_start();
    t.is_empty() || t.starts_with('#')
}

impl<'a> Parser<'a> {
    fn line(&self, i: usize) -> Line<'a> {
        let s = self.raw[i];
        let indent = s.len() - s.trim_start_matches(' ').len();
        Line {
            no: i + 1,
            indent,
            text: s[indent..].trim_end(),
        }
    }

    fn skip_blank(&mut self) {
        while self.pos < self.raw.len() && is_blank(self.raw[self.pos]) {
            self.pos += 1;
        }
    }

    /// The indentation of the next content line, if any.
    fn peek_indent(&mut self) -> Option<usize> {
        self.skip_blank();
        (self.pos < self.raw.len()).then(|| self.line(self.pos).indent)
    }

    fn map(&mut self, indent: usize) -> Result<Value, YamlError> {
        let mut out: Vec<(String, Value)> = Vec::new();
        while let Some(ind) = self.peek_indent() {
            if ind < indent {
                break;
            }
            let l = self.line(self.pos);
            if ind > indent {
                return Err(err(l.no, "unexpected indentation"));
            }
            if l.text.starts_with("- ") || l.text == "-" {
                return Err(err(l.no, "a list item where a key was expected"));
            }
            let (key, rest) = split_key(l.text).ok_or_else(|| err(l.no, "expected `key: value`"))?;
            self.pos += 1;
            let value = self.value_after_key(indent, rest, l.no)?;
            out.retain(|(k, _)| *k != key);
            out.push((key, value));
        }
        Ok(Value::Map(out))
    }

    fn value_after_key(&mut self, indent: usize, rest: &str, no: usize) -> Result<Value, YamlError> {
        let rest = strip_comment(rest).trim();
        if let Some(header) = rest.strip_prefix(['|', '>']) {
            let folded = rest.starts_with('>');
            return Ok(Value::Str(self.block_scalar(indent, folded, header)));
        }
        if rest.is_empty() {
            return match self.peek_indent() {
                Some(ind) if ind > indent => {
                    let l = self.line(self.pos);
                    if l.text.starts_with("- ") || l.text == "-" {
                        self.list(ind)
                    } else {
                        self.map(ind)
                    }
                }
                // A list may sit at the key's own indentation.
                Some(ind)
                    if ind == indent && {
                        let t = self.line(self.pos).text;
                        t.starts_with("- ") || t == "-"
                    } =>
                {
                    self.list(ind)
                }
                _ => Ok(Value::Null),
            };
        }
        self.inline(indent, rest, no)
    }

    fn inline(&mut self, indent: usize, rest: &str, no: usize) -> Result<Value, YamlError> {
        if rest.starts_with('[') {
            return flow_list(rest).ok_or_else(|| err(no, "an unclosed flow list"));
        }
        if rest.starts_with('{') {
            return Ok(Value::Str(rest.to_owned()));
        }
        if rest.starts_with('"') || rest.starts_with('\'') {
            return Ok(Value::Str(self.quoted(rest, no)?));
        }
        // A plain scalar may continue on more-indented lines, folded with spaces.
        let mut s = rest.to_owned();
        while let Some(ind) = self.peek_indent() {
            let l = self.line(self.pos);
            if ind <= indent {
                break;
            }
            if split_key(l.text).is_some() {
                return Err(err(l.no, "unexpected indentation"));
            }
            s.push(' ');
            s.push_str(strip_comment(l.text).trim());
            self.pos += 1;
        }
        Ok(plain(&s))
    }

    /// A quoted scalar starting in `first`, possibly spanning lines.
    fn quoted(&mut self, first: &str, no: usize) -> Result<String, YamlError> {
        let q = first.chars().next().unwrap_or('"');
        let mut text = first[1..].to_owned();
        loop {
            if let Some(end) = closing_quote(&text, q) {
                let inner = &text[..end];
                let s = if q == '"' {
                    unescape_double(inner).map_err(|m| err(no, m))?
                } else {
                    inner.replace("''", "'")
                };
                return Ok(s);
            }
            if self.pos >= self.raw.len() {
                return Err(err(no, "an unclosed quoted string"));
            }
            let next = self.raw[self.pos].trim();
            self.pos += 1;
            text.push(' ');
            text.push_str(next);
        }
    }

    fn block_scalar(&mut self, indent: usize, folded: bool, header: &str) -> String {
        let header = header.trim();
        let chomp = if header.contains('-') {
            '-'
        } else if header.contains('+') {
            '+'
        } else {
            ' '
        };
        let explicit: Option<usize> = header
            .chars()
            .find(char::is_ascii_digit)
            .and_then(|c| c.to_digit(10))
            .map(|d| d as usize);
        let mut lines: Vec<String> = Vec::new();
        let mut block_indent: Option<usize> = explicit.map(|d| indent + d);
        while self.pos < self.raw.len() {
            let s = self.raw[self.pos];
            if s.trim().is_empty() {
                lines.push(String::new());
                self.pos += 1;
                continue;
            }
            let ind = s.len() - s.trim_start_matches(' ').len();
            let bi = *block_indent.get_or_insert(ind);
            if ind < bi || ind <= indent {
                break;
            }
            lines.push(s[bi..].trim_end().to_owned());
            self.pos += 1;
        }
        // Trailing blank lines belong to chomping.
        let trailing = lines.iter().rev().take_while(|l| l.is_empty()).count();
        let content = &lines[..lines.len() - trailing];
        let mut out = String::new();
        if folded {
            let mut prev_blank = false;
            for (i, l) in content.iter().enumerate() {
                let more_indented = l.starts_with(' ');
                if i > 0 {
                    if l.is_empty() {
                        out.push('\n');
                    } else if prev_blank || more_indented {
                        if !prev_blank {
                            out.push('\n');
                        }
                    } else {
                        out.push(' ');
                    }
                }
                out.push_str(l);
                prev_blank = l.is_empty();
            }
        } else {
            out = content.join("\n");
        }
        match chomp {
            '-' => {}
            '+' => {
                out.push('\n');
                for _ in 0..trailing {
                    out.push('\n');
                }
            }
            _ => {
                if !content.is_empty() {
                    out.push('\n');
                }
            }
        }
        out
    }

    fn list(&mut self, indent: usize) -> Result<Value, YamlError> {
        let mut out = Vec::new();
        while let Some(ind) = self.peek_indent() {
            let l = self.line(self.pos);
            if ind != indent || !(l.text.starts_with("- ") || l.text == "-") {
                break;
            }
            self.pos += 1;
            let item = l.text[1..].trim_start();
            let item_indent = indent + (l.text.len() - item.len());
            if item.is_empty() {
                match self.peek_indent() {
                    Some(i) if i > indent => {
                        let t = self.line(self.pos).text;
                        out.push(if t.starts_with("- ") {
                            self.list(i)?
                        } else {
                            self.map(i)?
                        });
                    }
                    _ => out.push(Value::Null),
                }
            } else if let Some((key, rest)) = split_key(item) {
                // `- key: value` starts a mapping whose other keys are indented like `key`.
                let first = self.value_after_key(item_indent, rest, l.no)?;
                let mut map = vec![(key, first)];
                if let Some(i) = self.peek_indent()
                    && i == item_indent
                    && let Value::Map(more) = self.map(item_indent)?
                {
                    map.extend(more);
                }
                out.push(Value::Map(map));
            } else {
                out.push(self.inline(indent, strip_comment(item).trim(), l.no)?);
            }
        }
        Ok(Value::List(out))
    }
}

/// `key: rest` (the key plain or quoted), or `None`.
fn split_key(text: &str) -> Option<(String, &str)> {
    if text.starts_with('#') {
        return None;
    }
    if let Some(q @ ('"' | '\'')) = text.chars().next() {
        let end = closing_quote(&text[1..], q)? + 1;
        let rest = text[end + 1..].strip_prefix(':')?;
        if !(rest.is_empty() || rest.starts_with(' ')) {
            return None;
        }
        let key = &text[1..end];
        return Some((key.to_owned(), rest));
    }
    let mut search = 0;
    while let Some(i) = text[search..].find(':') {
        let at = search + i;
        let after = &text[at + 1..];
        if after.is_empty() || after.starts_with(' ') || after.starts_with('\t') {
            let key = text[..at].trim();
            if key.is_empty() || key.starts_with(['-', '[', '{']) && key.len() == 1 {
                return None;
            }
            return Some((key.to_owned(), after));
        }
        search = at + 1;
    }
    None
}

/// The index of the closing quote in `s` (which starts after the opening one).
fn closing_quote(s: &str, q: char) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if q == '"' && c == b'\\' {
            i += 2;
            continue;
        }
        if c == q as u8 {
            if q == '\'' && b.get(i + 1) == Some(&b'\'') {
                i += 2;
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

fn unescape_double(s: &str) -> Result<String, String> {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('0') => out.push('\0'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('/') => out.push('/'),
            Some(' ') => out.push(' '),
            Some('u') => {
                let hex: String = it.by_ref().take(4).collect();
                let cp = u32::from_str_radix(&hex, 16).map_err(|_| format!("bad escape \\u{hex}"))?;
                out.push(char::from_u32(cp).ok_or_else(|| format!("bad escape \\u{hex}"))?);
            }
            Some(other) => return Err(format!("unknown escape \\{other}")),
            None => return Err("a trailing backslash".into()),
        }
    }
    Ok(out)
}

/// Removes a ` # comment` from a plain value (a `#` inside quotes is kept).
fn strip_comment(s: &str) -> &str {
    let b = s.as_bytes();
    let mut quote: Option<u8> = None;
    for i in 0..b.len() {
        match (quote, b[i]) {
            (None, b'"' | b'\'') if i == 0 || b[i - 1] == b' ' || b[i - 1] == b'[' || b[i - 1] == b',' => {
                quote = Some(b[i]);
            }
            (Some(q), c) if c == q => quote = None,
            (None, b'#') if i == 0 || b[i - 1] == b' ' || b[i - 1] == b'\t' => return &s[..i],
            _ => {}
        }
    }
    s
}

fn plain(s: &str) -> Value {
    let t = s.trim();
    if t.is_empty() || t == "~" || t == "null" || t == "Null" || t == "NULL" {
        return Value::Null;
    }
    Value::Str(t.to_owned())
}

fn flow_list(s: &str) -> Option<Value> {
    let inner = s.trim().strip_prefix('[')?.strip_suffix(']')?;
    let mut items = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut depth = 0usize;
    let push = |cur: &mut String, items: &mut Vec<Value>| {
        let t = cur.trim();
        if !t.is_empty() {
            let v = if let Some(q @ ('"' | '\'')) = t.chars().next() {
                let body = &t[1..t.len().saturating_sub(1).max(1)];
                Value::Str(if q == '"' {
                    unescape_double(body).unwrap_or_else(|_| body.to_owned())
                } else {
                    body.replace("''", "'")
                })
            } else {
                plain(t)
            };
            items.push(v);
        }
        cur.clear();
    };
    for c in inner.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => {
                quote = None;
                cur.push(c);
            }
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                cur.push(c);
            }
            (None, '(' | '[' | '{') => {
                depth += 1;
                cur.push(c);
            }
            (None, ')' | ']' | '}') => {
                depth = depth.saturating_sub(1);
                cur.push(c);
            }
            (None, ',') if depth == 0 => push(&mut cur, &mut items),
            (None, c) => cur.push(c),
        }
    }
    push(&mut cur, &mut items);
    Some(Value::List(items))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Value {
        Value::Str(v.into())
    }

    #[test]
    fn a_document_splits_into_frontmatter_and_body() {
        let (fm, body) = split("---\nname: x\n---\n# Title\n").expect("frontmatter");
        assert_eq!(fm, "name: x\n");
        assert_eq!(body, "# Title\n");
        assert!(split("# no frontmatter\n").is_none());
        assert!(split("---\nname: x\n").is_none(), "unclosed");
        assert!(split("\u{feff}---\r\nname: x\r\n---\r\nbody").is_some());
    }

    #[test]
    fn scalars_quotes_and_comments() {
        let v = parse(
            "name: ultrasearch # the name\ndescription: \"Say \\\"hi\\\": now\"\nquote: 'it''s'\nempty:\nflag: true\nurl: https://x.y/z#frag\n",
        )
        .expect("parses");
        assert_eq!(v.get("name"), Some(&s("ultrasearch")));
        assert_eq!(v.get("description"), Some(&s("Say \"hi\": now")));
        assert_eq!(v.get("quote"), Some(&s("it's")));
        assert_eq!(v.get("empty"), Some(&Value::Null));
        assert_eq!(v.get("flag").and_then(Value::as_bool), Some(true));
        assert_eq!(v.get("url"), Some(&s("https://x.y/z#frag")));
    }

    #[test]
    fn block_scalars_fold_or_keep_lines() {
        let v = parse("a: >-\n  one\n  two\n\n  three\nb: |\n  line 1\n  line 2\nc: x\n").expect("parses");
        assert_eq!(v.get("a"), Some(&s("one two\nthree")));
        assert_eq!(v.get("b"), Some(&s("line 1\nline 2\n")));
        assert_eq!(v.get("c"), Some(&s("x")));
    }

    #[test]
    fn nested_maps_and_lists() {
        let v = parse(
            "metadata:\n  version: 1.41.1\n  opencode/autoinvoke: 'true'\nallowed-tools:\n  - Bash(git:*)\n  - Read\nflow: [a, \"b, c\", Bash(x, y)]\nitems:\n- k: v\n  j: w\n",
        )
        .expect("parses");
        let meta = v.get("metadata").expect("metadata");
        assert_eq!(meta.get("version"), Some(&s("1.41.1")));
        assert_eq!(meta.get("opencode/autoinvoke").and_then(Value::as_bool), Some(true));
        assert_eq!(
            v.get("allowed-tools"),
            Some(&Value::List(vec![s("Bash(git:*)"), s("Read")]))
        );
        assert_eq!(
            v.get("flow"),
            Some(&Value::List(vec![s("a"), s("b, c"), s("Bash(x, y)")]))
        );
        assert_eq!(
            v.get("items"),
            Some(&Value::List(vec![Value::Map(vec![
                ("k".into(), s("v")),
                ("j".into(), s("w"))
            ])]))
        );
    }

    #[test]
    fn plain_scalars_continue_on_indented_lines() {
        let v = parse("description: Research a topic\n  and write a report.\nname: x\n").expect("parses");
        assert_eq!(v.get("description"), Some(&s("Research a topic and write a report.")));
    }

    #[test]
    fn broken_yaml_is_an_error_with_a_line() {
        let e = parse("name: x\n   bad: indent\n").expect_err("fails");
        assert_eq!(e.line, 2);
        assert!(parse("description: \"open\n").is_err());
        assert!(parse("- a\n").is_err());
    }
}
