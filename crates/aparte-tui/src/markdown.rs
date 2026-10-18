//! Markdown to terminal lines: headings, emphasis, inline code, lists, quotes, links and rules with pulldown-cmark,
//! code blocks highlighted with syntect (its pure-Rust regex engine). Model output is untrusted text: it is only
//! ever turned into styled characters, never into terminal escape sequences, and control characters are dropped.

use std::sync::LazyLock;

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::parsing::SyntaxSet;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);
static THEME: LazyLock<Theme> = LazyLock::new(|| {
    let mut themes = ThemeSet::load_defaults();
    themes.themes.remove("base16-ocean.dark").unwrap_or_default()
});

/// How text is styled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    /// False with `NO_COLOR`: modifiers only.
    pub color: bool,
}

impl Palette {
    fn fg(self, c: Color) -> Style {
        if self.color {
            Style::default().fg(c)
        } else {
            Style::default()
        }
    }
}

/// Removes control characters (escape sequences included) from untrusted text; tabs become spaces.
pub fn sanitize(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            '\t' => Some(' '),
            '\n' => Some('\n'),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

struct Builder {
    palette: Palette,
    lines: Vec<Line<'static>>,
    current: Vec<Span<'static>>,
    styles: Vec<Style>,
    /// List nesting: `None` for bullets, `Some(n)` for the next number.
    lists: Vec<Option<u64>>,
    quote: usize,
    code: Option<String>,
    code_buf: String,
    link: Option<String>,
}

impl Builder {
    fn style(&self) -> Style {
        self.styles.iter().fold(Style::default(), |a, s| a.patch(*s))
    }

    fn prefix(&self) -> Vec<Span<'static>> {
        let mut p = Vec::new();
        for _ in 0..self.quote {
            p.push(Span::styled("│ ", self.palette.fg(Color::DarkGray)));
        }
        p
    }

    fn push_text(&mut self, text: &str) {
        let style = self.style();
        let mut first = true;
        for piece in text.split('\n') {
            if !first {
                self.flush();
            }
            first = false;
            if !piece.is_empty() {
                if self.current.is_empty() {
                    let p = self.prefix();
                    self.current.extend(p);
                }
                self.current.push(Span::styled(piece.to_owned(), style));
            }
        }
    }

    fn flush(&mut self) {
        let spans = std::mem::take(&mut self.current);
        self.lines.push(Line::from(spans));
    }

    fn end_block(&mut self) {
        if !self.current.is_empty() {
            self.flush();
        }
        if self.lists.is_empty() && self.lines.last().is_some_and(|l| !l.spans.is_empty()) {
            self.lines.push(Line::default());
        }
    }

    fn code_block(&mut self) {
        let lang = self.code.take().unwrap_or_default();
        let code = std::mem::take(&mut self.code_buf);
        let syntax = SYNTAXES
            .find_syntax_by_token(lang.split_whitespace().next().unwrap_or_default())
            .unwrap_or_else(|| SYNTAXES.find_syntax_plain_text());
        let mut h = HighlightLines::new(syntax, &THEME);
        let gutter = Span::styled("  ", Style::default());
        for line in syntect::util::LinesWithEndings::from(&code) {
            let mut spans = self.prefix();
            spans.push(gutter.clone());
            match h.highlight_line(line, &SYNTAXES) {
                Ok(ranges) if self.palette.color => {
                    for (st, piece) in ranges {
                        let piece = piece.trim_end_matches(['\n', '\r']);
                        if piece.is_empty() {
                            continue;
                        }
                        let c = st.foreground;
                        spans.push(Span::styled(
                            piece.to_owned(),
                            Style::default().fg(Color::Rgb(c.r, c.g, c.b)),
                        ));
                    }
                }
                _ => spans.push(Span::raw(line.trim_end_matches(['\n', '\r']).to_owned())),
            }
            self.lines.push(Line::from(spans));
        }
        self.lines.push(Line::default());
    }
}

/// Renders Markdown into lines (not wrapped; see [`wrap`]).
pub fn render(markdown: &str, palette: Palette) -> Vec<Line<'static>> {
    let text = sanitize(markdown);
    let mut b = Builder {
        palette,
        lines: Vec::new(),
        current: Vec::new(),
        styles: Vec::new(),
        lists: Vec::new(),
        quote: 0,
        code: None,
        code_buf: String::new(),
        link: None,
    };
    let opts = Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    for ev in Parser::new_ext(&text, opts) {
        match ev {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    let color = if level == HeadingLevel::H1 {
                        Color::Cyan
                    } else {
                        Color::Blue
                    };
                    b.styles.push(palette.fg(color).add_modifier(Modifier::BOLD));
                    let hashes = "#".repeat(level as usize);
                    b.push_text(&format!("{hashes} "));
                }
                Tag::Emphasis => b.styles.push(Style::default().add_modifier(Modifier::ITALIC)),
                Tag::Strong => b.styles.push(Style::default().add_modifier(Modifier::BOLD)),
                Tag::Strikethrough => b.styles.push(Style::default().add_modifier(Modifier::CROSSED_OUT)),
                Tag::BlockQuote(_) => b.quote += 1,
                Tag::CodeBlock(kind) => {
                    if !b.current.is_empty() {
                        b.flush();
                    }
                    b.code = Some(match kind {
                        CodeBlockKind::Fenced(lang) => lang.to_string(),
                        CodeBlockKind::Indented => String::new(),
                    });
                }
                Tag::List(start) => {
                    if !b.current.is_empty() {
                        b.flush();
                    }
                    b.lists.push(start);
                }
                Tag::Item => {
                    if !b.current.is_empty() {
                        b.flush();
                    }
                    let depth = b.lists.len().saturating_sub(1);
                    let marker = match b.lists.last_mut() {
                        Some(Some(n)) => {
                            let m = format!("{n}. ");
                            *n += 1;
                            m
                        }
                        _ => "• ".to_owned(),
                    };
                    let mut spans = b.prefix();
                    spans.push(Span::raw("  ".repeat(depth)));
                    spans.push(Span::styled(marker, palette.fg(Color::Yellow)));
                    b.current = spans;
                }
                Tag::Link { dest_url, .. } => {
                    b.link = Some(dest_url.to_string());
                    b.styles
                        .push(palette.fg(Color::Blue).add_modifier(Modifier::UNDERLINED));
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Heading(_) => {
                    b.styles.pop();
                    b.end_block();
                }
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                    b.styles.pop();
                }
                TagEnd::Paragraph => b.end_block(),
                TagEnd::BlockQuote(_) => {
                    b.quote = b.quote.saturating_sub(1);
                    b.end_block();
                }
                TagEnd::CodeBlock => b.code_block(),
                TagEnd::List(_) => {
                    b.lists.pop();
                    if !b.current.is_empty() {
                        b.flush();
                    }
                    if b.lists.is_empty() {
                        b.lines.push(Line::default());
                    }
                }
                TagEnd::Item => {
                    if !b.current.is_empty() {
                        b.flush();
                    }
                }
                TagEnd::Link => {
                    b.styles.pop();
                    if let Some(url) = b.link.take() {
                        let style = palette.fg(Color::DarkGray);
                        b.current.push(Span::styled(format!(" ({url})"), style));
                    }
                }
                TagEnd::TableRow | TagEnd::TableHead => b.flush(),
                TagEnd::Table => b.end_block(),
                _ => {}
            },
            Event::Text(t) => {
                if b.code.is_some() {
                    b.code_buf.push_str(&t);
                } else {
                    b.push_text(&t);
                }
            }
            Event::Code(t) => {
                let style = palette.fg(Color::Magenta);
                if b.current.is_empty() {
                    let p = b.prefix();
                    b.current.extend(p);
                }
                b.current.push(Span::styled(format!("`{t}`"), style));
            }
            Event::SoftBreak => b.push_text(" "),
            Event::HardBreak => b.flush(),
            Event::Rule => {
                if !b.current.is_empty() {
                    b.flush();
                }
                b.lines.push(Line::styled("─".repeat(40), palette.fg(Color::DarkGray)));
                b.lines.push(Line::default());
            }
            Event::TaskListMarker(done) => b.push_text(if done { "[x] " } else { "[ ] " }),
            Event::Html(h) | Event::InlineHtml(h) => b.push_text(&h),
            Event::FootnoteReference(_) | Event::InlineMath(_) | Event::DisplayMath(_) => {}
        }
    }
    if !b.current.is_empty() {
        b.flush();
    }
    while b.lines.last().is_some_and(|l| l.spans.is_empty()) {
        b.lines.pop();
    }
    b.lines
}

/// Wraps lines to `width` columns at spaces, keeping styles; a word longer than the width is cut.
pub fn wrap(lines: &[Line<'static>], width: u16) -> Vec<Line<'static>> {
    let width = usize::from(width.max(8));
    let mut out = Vec::new();
    for line in lines {
        if line.width() <= width {
            out.push(line.clone());
            continue;
        }
        let mut cur: Vec<Span<'static>> = Vec::new();
        let mut used = 0usize;
        for span in &line.spans {
            for word in span.content.split_inclusive(' ') {
                let w = word.width();
                if used + w > width && used > 0 {
                    out.push(Line::from(std::mem::take(&mut cur)));
                    used = 0;
                }
                let mut word = word.to_owned();
                while word.width() > width {
                    let mut cut = String::new();
                    let mut cw = 0;
                    for ch in word.chars() {
                        let chw = UnicodeWidthChar::width(ch).unwrap_or(0);
                        if cw + chw > width {
                            break;
                        }
                        cw += chw;
                        cut.push(ch);
                    }
                    word = word[cut.len()..].to_owned();
                    out.push(Line::from(vec![Span::styled(cut, span.style)]));
                }
                used += word.width();
                cur.push(Span::styled(word, span.style));
            }
        }
        if !cur.is_empty() {
            out.push(Line::from(cur));
        }
    }
    out
}

/// Plain text of lines, for tests and logs.
pub fn plain(lines: &[Line<'_>]) -> String {
    lines
        .iter()
        .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: Palette = Palette { color: true };

    #[test]
    fn headings_lists_and_inline_code_render() {
        let md = "# Title\n\nSome *em* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n";
        let text = plain(&render(md, P));
        assert_eq!(
            text,
            "# Title\n\nSome em and `code`.\n\n• one\n• two\n\n1. first\n2. second"
        );
    }

    #[test]
    fn code_blocks_are_highlighted() {
        let lines = render("```rust\nfn main() {}\n```\n", P);
        assert_eq!(plain(&lines), "  fn main() {}");
        assert!(
            lines[0]
                .spans
                .iter()
                .any(|s| matches!(s.style.fg, Some(Color::Rgb(..))))
        );
        let plain_lines = render("```rust\nfn main() {}\n```\n", Palette { color: false });
        assert!(plain_lines[0].spans.iter().all(|s| s.style.fg.is_none()));
    }

    #[test]
    fn escape_sequences_from_the_model_are_removed() {
        let text = plain(&render("red \u{1b}[31mtext\u{7}", P));
        assert_eq!(text, "red [31mtext");
    }

    #[test]
    fn links_show_their_target_and_quotes_their_bar() {
        let text = plain(&render("> see [docs](https://x.y)\n", P));
        assert_eq!(text, "│ see docs (https://x.y)");
    }

    #[test]
    fn long_lines_wrap_at_spaces() {
        let lines = render("aaa bbb ccc ddd eee", P);
        let wrapped = wrap(&lines, 8);
        assert_eq!(plain(&wrapped), "aaa bbb \nccc ddd \neee");
        let long = wrap(&[Line::from("x".repeat(20))], 8);
        assert_eq!(long.len(), 3);
    }
}
