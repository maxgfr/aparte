//! The interface state, without any terminal: agent events go in, lines for the scrollback and a frame for the
//! inline viewport come out. Finished output (the user's prompts, answers, tool calls and results) goes to the
//! terminal's own scrollback, so it stays there after exit; the viewport only holds what is still changing, the
//! status line and the input.

use aparte_agent::{AgentEvent, ApprovalRequest, EndReason};
use aparte_llm::{Part, Usage};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui_textarea::TextArea;
use serde_json::Value;

use crate::markdown::{self, Palette, sanitize};

/// Lines of a tool result shown in the scrollback.
const RESULT_LINES: usize = 6;

/// Everything the interface shows.
pub struct App {
    pub palette: Palette,
    /// `provider/model`, for the status line.
    pub model_label: String,
    pub input: TextArea<'static>,
    /// The answer being streamed, as Markdown.
    pub streaming: String,
    /// The reasoning being streamed.
    pub reasoning: String,
    pub running: bool,
    pub turn: u32,
    pub usage: Usage,
    /// A short note on the status line (last outcome, help).
    pub note: String,
    /// The approval waiting for an answer.
    pub pending: Option<ApprovalRequest>,
    pub quit: bool,
    width: u16,
    scrollback: Vec<Line<'static>>,
}

fn dim(p: Palette) -> Style {
    if p.color {
        Style::default().fg(Color::DarkGray)
    } else {
        Style::default().add_modifier(Modifier::DIM)
    }
}

fn colored(p: Palette, c: Color) -> Style {
    if p.color {
        Style::default().fg(c)
    } else {
        Style::default()
    }
}

/// A one-line summary of a tool input: the main argument when there is one.
pub fn summarize_input(tool: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_owned);
    let main = match tool {
        "bash" => s("command"),
        "read" | "write" | "edit" | "ls" => s("path"),
        "grep" | "find" => s("pattern").map(|p| match s("path") {
            Some(path) => format!("{p} in {path}"),
            None => p,
        }),
        "git" => input
            .get("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")),
        "web_fetch" => s("url"),
        "skill" => s("name").map(|n| match s("path") {
            Some(p) => format!("{n} {p}"),
            None => n,
        }),
        _ => None,
    };
    let text = main.unwrap_or_else(|| input.to_string());
    let text = sanitize(&text).replace('\n', " ⏎ ");
    if text.chars().count() > 160 {
        format!("{}…", text.chars().take(160).collect::<String>())
    } else {
        text
    }
}

impl App {
    /// A fresh interface.
    pub fn new(model_label: impl Into<String>, palette: Palette) -> App {
        let mut input = TextArea::default();
        input.set_placeholder_text(
            "Ask anything. Enter sends, Shift+Enter or Ctrl+J adds a line, /help lists commands.",
        );
        input.set_cursor_line_style(Style::default());
        input.set_block(Block::default().borders(Borders::TOP).border_style(dim(palette)));
        App {
            palette,
            model_label: model_label.into(),
            input,
            streaming: String::new(),
            reasoning: String::new(),
            running: false,
            turn: 0,
            usage: Usage::default(),
            note: String::new(),
            pending: None,
            quit: false,
            width: 80,
            scrollback: Vec::new(),
        }
    }

    /// Sets the terminal width used to wrap scrollback lines.
    pub fn set_width(&mut self, width: u16) {
        self.width = width.max(20);
    }

    /// Lines to print above the viewport, wrapped; empties the queue.
    pub fn take_scrollback(&mut self) -> Vec<Line<'static>> {
        let lines = std::mem::take(&mut self.scrollback);
        markdown::wrap(&lines, self.width)
    }

    /// Prints a line of the interface's own (help, command results).
    pub fn say(&mut self, text: &str) {
        for l in text.lines() {
            self.scrollback.push(Line::styled(l.to_owned(), dim(self.palette)));
        }
    }

    /// Shows the user's prompt in the scrollback.
    pub fn user_prompt(&mut self, text: &str) {
        let style = colored(self.palette, Color::Green).add_modifier(Modifier::BOLD);
        for (i, l) in sanitize(text).lines().enumerate() {
            let mark = if i == 0 { "› " } else { "  " };
            self.scrollback
                .push(Line::from(vec![Span::styled(mark, style), Span::raw(l.to_owned())]));
        }
        self.scrollback.push(Line::default());
    }

    fn flush_streaming(&mut self) {
        if !self.reasoning.trim().is_empty() {
            let first = self.reasoning.trim().lines().next().unwrap_or_default().to_owned();
            let more = self.reasoning.trim().lines().count() > 1;
            let text = format!("✻ {}{}", sanitize(&first), if more { " …" } else { "" });
            self.scrollback
                .push(Line::styled(text, dim(self.palette).add_modifier(Modifier::ITALIC)));
        }
        self.reasoning.clear();
        if !self.streaming.trim().is_empty() {
            let lines = markdown::render(&self.streaming, self.palette);
            self.scrollback.extend(lines);
            self.scrollback.push(Line::default());
        }
        self.streaming.clear();
    }

    fn tool_result(&mut self, name: &str, content: &str, is_error: bool, details: Option<&Value>) {
        let style = if is_error {
            colored(self.palette, Color::Red)
        } else {
            dim(self.palette)
        };
        if let Some(diff) = details
            .and_then(|d| d.get("diff"))
            .and_then(Value::as_str)
            .filter(|_| name == "edit")
        {
            for l in sanitize(diff).lines().skip(2).take(RESULT_LINES * 3) {
                let st = match l.chars().next() {
                    Some('+') => colored(self.palette, Color::Green),
                    Some('-') => colored(self.palette, Color::Red),
                    _ => dim(self.palette),
                };
                self.scrollback.push(Line::styled(format!("  {l}"), st));
            }
            return;
        }
        let clean = sanitize(content);
        let lines: Vec<&str> = clean.lines().collect();
        for l in lines.iter().take(RESULT_LINES) {
            self.scrollback.push(Line::styled(format!("  {l}"), style));
        }
        if lines.len() > RESULT_LINES {
            self.scrollback.push(Line::styled(
                format!("  … {} more lines", lines.len() - RESULT_LINES),
                dim(self.palette),
            ));
        }
    }

    /// Applies one agent event.
    pub fn on_event(&mut self, ev: &AgentEvent) {
        match ev {
            AgentEvent::AgentStart => {
                self.running = true;
                self.note.clear();
            }
            AgentEvent::TurnStart { turn } => self.turn = *turn,
            AgentEvent::TextDelta { text } => self.streaming.push_str(text),
            AgentEvent::ReasoningDelta { text } => self.reasoning.push_str(text),
            AgentEvent::MessageEnd { message } => {
                // The streamed text is the message's text; tool calls are shown when they start.
                if self.streaming.is_empty() {
                    for p in &message.content {
                        if let Part::Text { text } = p {
                            self.streaming.push_str(text);
                        }
                    }
                }
                self.flush_streaming();
            }
            AgentEvent::ToolStart { name, input, .. } => {
                let head = Span::styled(
                    format!("▸ {name} "),
                    colored(self.palette, Color::Cyan).add_modifier(Modifier::BOLD),
                );
                self.scrollback
                    .push(Line::from(vec![head, Span::raw(summarize_input(name, input))]));
            }
            AgentEvent::ToolEnd { name, output, .. } => {
                self.tool_result(name, &output.content, output.is_error, output.details.as_ref());
            }
            AgentEvent::Steer { text } | AgentEvent::FollowUp { text } => self.user_prompt(text),
            AgentEvent::Refusal { category, explanation } => {
                self.streaming.clear();
                self.reasoning.clear();
                let what = category.as_deref().unwrap_or("unspecified");
                let why = explanation
                    .as_deref()
                    .map(|e| format!(": {}", sanitize(e)))
                    .unwrap_or_default();
                self.scrollback.push(Line::styled(
                    format!("The model declined to answer (category {what}){why}"),
                    colored(self.palette, Color::Red),
                ));
                self.scrollback.push(Line::default());
            }
            AgentEvent::Error { error } => {
                self.flush_streaming();
                self.scrollback.push(Line::styled(
                    format!("Error: {}", sanitize(&error.to_string())),
                    colored(self.palette, Color::Red),
                ));
            }
            AgentEvent::Usage { .. }
            | AgentEvent::ToolCallStart { .. }
            | AgentEvent::TurnEnd { .. }
            | AgentEvent::Source { .. } => {}
            AgentEvent::AgentEnd { reason, usage } => {
                self.flush_streaming();
                self.running = false;
                let add = |a: Option<u64>, b: Option<u64>| match (a, b) {
                    (None, None) => None,
                    (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
                };
                self.usage.input = add(self.usage.input, usage.input);
                self.usage.output = add(self.usage.output, usage.output);
                self.note = match reason {
                    EndReason::Done => String::new(),
                    EndReason::Aborted => "aborted".into(),
                    EndReason::MaxTurns => "stopped: too many turns".into(),
                    EndReason::Error => "stopped on an error".into(),
                    EndReason::Refusal => "refused".into(),
                    EndReason::Stopped => "stopped by a hook".into(),
                };
            }
        }
    }

    fn status_line(&self) -> Line<'static> {
        let state = if self.pending.is_some() {
            "approval needed".to_owned()
        } else if self.running {
            format!(
                "working (turn {}) · Esc aborts, Enter steers, Alt+Enter queues",
                self.turn
            )
        } else if self.note.is_empty() {
            "ready".to_owned()
        } else {
            self.note.clone()
        };
        let tokens = match (self.usage.input, self.usage.output) {
            (Some(i), Some(o)) => format!(" · {i} in / {o} out"),
            _ => String::new(),
        };
        Line::styled(format!("{} · {state}{tokens}", self.model_label), dim(self.palette))
    }

    fn live_lines(&self, area: Rect) -> Vec<Line<'static>> {
        if let Some(req) = &self.pending {
            let warn = colored(self.palette, Color::Yellow).add_modifier(Modifier::BOLD);
            return vec![
                Line::styled(format!("Allow {}?", req.tool), warn),
                Line::raw(format!("  {}", summarize_input(&req.tool, &req.input))),
                Line::styled("  y: yes   a: always for this tool   n or Esc: no", dim(self.palette)),
            ];
        }
        let lines = if self.streaming.is_empty() && !self.reasoning.is_empty() {
            let text = sanitize(&self.reasoning);
            text.lines()
                .map(|l| Line::styled(format!("✻ {l}"), dim(self.palette).add_modifier(Modifier::ITALIC)))
                .collect()
        } else {
            markdown::render(&self.streaming, self.palette)
        };
        let wrapped = markdown::wrap(&lines, area.width);
        let keep = usize::from(area.height);
        wrapped[wrapped.len().saturating_sub(keep)..].to_vec()
    }

    /// Draws the viewport: live output, status line, input.
    pub fn draw(&self, frame: &mut Frame<'_>) {
        let area = frame.area();
        let [live, status, input] =
            Layout::vertical([Constraint::Min(1), Constraint::Length(1), Constraint::Length(4)]).areas(area);
        frame.render_widget(Paragraph::new(self.live_lines(live)), live);
        frame.render_widget(Paragraph::new(self.status_line()), status);
        frame.render_widget(&self.input, input);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aparte_agent::ToolOutput;
    use aparte_llm::Message;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use serde_json::json;

    const P: Palette = Palette { color: false };

    fn text(lines: &[Line<'_>]) -> String {
        markdown::plain(lines)
    }

    #[test]
    fn a_turn_goes_to_the_scrollback_in_order() {
        let mut app = App::new("anthropic/claude-opus-5-5", P);
        app.user_prompt("list files");
        app.on_event(&AgentEvent::AgentStart);
        app.on_event(&AgentEvent::ReasoningDelta {
            text: "Let me look.".into(),
        });
        app.on_event(&AgentEvent::TextDelta {
            text: "Sure, **looking**.".into(),
        });
        app.on_event(&AgentEvent::MessageEnd {
            message: Message::assistant("Sure, **looking**."),
        });
        app.on_event(&AgentEvent::ToolStart {
            call_id: "1".into(),
            name: "ls".into(),
            input: json!({"path": "."}),
        });
        app.on_event(&AgentEvent::ToolEnd {
            call_id: "1".into(),
            name: "ls".into(),
            output: ToolOutput::text("a\nb"),
        });
        app.on_event(&AgentEvent::AgentEnd {
            reason: EndReason::Done,
            usage: Usage::default(),
        });
        let out = text(&app.take_scrollback());
        assert_eq!(
            out,
            "› list files\n\n✻ Let me look.\nSure, looking.\n\n▸ ls .\n  a\n  b"
        );
        assert!(!app.running);
    }

    #[test]
    fn the_viewport_shows_streaming_text_status_and_approvals() {
        let mut app = App::new("test/model", P);
        app.on_event(&AgentEvent::AgentStart);
        app.on_event(&AgentEvent::TextDelta {
            text: "partial answer".into(),
        });
        let mut term = Terminal::new(TestBackend::new(60, 10)).expect("terminal");
        term.draw(|f| app.draw(f)).expect("draw");
        let screen = format!("{:?}", term.backend().buffer());
        assert!(screen.contains("partial answer"));
        assert!(screen.contains("test/model · working"));
        app.pending = Some(ApprovalRequest {
            call_id: "c".into(),
            tool: "bash".into(),
            input: json!({"command": "rm -rf build"}),
            annotations: aparte_agent::Annotations::default(),
        });
        term.draw(|f| app.draw(f)).expect("draw");
        let screen = format!("{:?}", term.backend().buffer());
        assert!(screen.contains("Allow bash?") && screen.contains("rm -rf build"));
    }

    #[test]
    fn edit_results_show_their_diff() {
        let mut app = App::new("m", P);
        let output =
            ToolOutput::text("Applied").with_details(json!({"diff": "--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new\n"}));
        app.on_event(&AgentEvent::ToolEnd {
            call_id: "1".into(),
            name: "edit".into(),
            output,
        });
        assert_eq!(text(&app.take_scrollback()), "  @@ -1 +1 @@\n  -old\n  +new");
    }
}
