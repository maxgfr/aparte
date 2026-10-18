//! The terminal loop: an inline viewport at the bottom of the terminal (the scrollback above it is kept), keys
//! from crossterm, events from the agent, which runs in its own task, and approvals asked through a channel.
//!
//! Keys: Enter sends (or steers a running agent), Alt+Enter queues a follow-up, Shift+Enter or Ctrl+J adds a
//! line, Esc aborts a run, Ctrl+C aborts or clears or quits, Ctrl+D quits on an empty input.

use std::path::Path;
use std::sync::Arc;

use aparte_agent::session::{self, SessionHeader};
use aparte_agent::{Agent, AgentEvent, Approval, ApprovalRequest, Approver, BoxFuture, EventSink, RunOutcome};
use aparte_llm::Effort;
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures_util::StreamExt;
use ratatui::text::Line;
use ratatui::widgets::{Paragraph, Widget};
use ratatui::{DefaultTerminal, TerminalOptions, Viewport};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::app::App;
use crate::markdown::Palette;

/// An approval waiting for the user.
pub struct Ask {
    pub request: ApprovalRequest,
    pub reply: oneshot::Sender<Approval>,
}

/// Sends approval requests to the interface and waits for the answer.
#[derive(Debug, Clone)]
pub struct ChannelApprover {
    tx: mpsc::UnboundedSender<Ask>,
}

impl Approver for ChannelApprover {
    fn approve<'a>(&'a self, req: &'a ApprovalRequest) -> BoxFuture<'a, Approval> {
        Box::pin(async move {
            let (reply, rx) = oneshot::channel();
            let ask = Ask {
                request: req.clone(),
                reply,
            };
            if self.tx.send(ask).is_err() {
                return Approval::Deny {
                    reason: Some("the interface is closed".into()),
                };
            }
            rx.await.unwrap_or(Approval::Deny { reason: None })
        })
    }
}

/// The receiving ends the interface reads.
pub struct Channels {
    pub events: mpsc::UnboundedReceiver<AgentEvent>,
    pub asks: mpsc::UnboundedReceiver<Ask>,
}

/// An event sink and an approver that feed the interface, and the channels it reads them from.
pub fn channels() -> (EventSink, Arc<ChannelApprover>, Channels) {
    let (etx, events) = mpsc::unbounded_channel();
    let (atx, asks) = mpsc::unbounded_channel();
    let sink: EventSink = Arc::new(move |e: &AgentEvent| {
        let _ = etx.send(e.clone());
    });
    (sink, Arc::new(ChannelApprover { tx: atx }), Channels { events, asks })
}

/// How the interface is set up.
#[derive(Debug, Clone)]
pub struct Options {
    /// The provider id, for the status line and session exports.
    pub provider: String,
    pub palette: Palette,
    /// Rows of the inline viewport.
    pub height: u16,
}

const HELP: &str = "\
Commands:
  /help              this list
  /model <id>        switch model
  /effort <level>    none, minimal, low, medium, high, xhigh, max, or off
  /export <file>     write the conversation as JSONL
  /clear             start a new conversation
  /quit              leave (also Ctrl+D)
Keys: Enter sends or steers, Alt+Enter queues a follow-up, Shift+Enter or Ctrl+J new line, Esc aborts.";

struct State {
    app: App,
    agent: Option<Agent>,
    task: Option<JoinHandle<(Agent, RunOutcome)>>,
    reply: Option<oneshot::Sender<Approval>>,
    handle: aparte_agent::AgentHandle,
    provider: String,
}

impl State {
    fn label(&self) -> String {
        let model = self
            .agent
            .as_ref()
            .map(|a| a.config().model.clone())
            .unwrap_or_default();
        format!("{}/{model}", self.provider)
    }

    fn start(&mut self, text: String) {
        let Some(mut agent) = self.agent.take() else {
            return;
        };
        self.app.user_prompt(&text);
        self.app.running = true;
        self.task = Some(tokio::spawn(async move {
            let out = agent.prompt(text).await;
            (agent, out)
        }));
    }

    fn command(&mut self, line: &str) {
        let mut parts = line.splitn(2, char::is_whitespace);
        let cmd = parts.next().unwrap_or_default();
        let arg = parts.next().unwrap_or_default().trim();
        let Some(agent) = self.agent.as_mut() else {
            return;
        };
        match cmd {
            "/help" => self.app.say(HELP),
            "/quit" | "/exit" => self.app.quit = true,
            "/clear" => {
                agent.set_messages(Vec::new());
                self.app.say("new conversation");
            }
            "/model" if !arg.is_empty() => {
                agent.config_mut().model = arg.to_owned();
                agent.config_mut().effort = None;
                self.app.model_label = self.label();
                self.app.say(&format!("model: {arg} (effort reset)"));
            }
            "/effort" if arg == "off" => {
                agent.config_mut().effort = None;
                self.app.say("effort: provider default");
            }
            "/effort" => match Effort::parse(arg) {
                Some(e) => {
                    agent.config_mut().effort = Some(e);
                    self.app.say(&format!("effort: {e}"));
                }
                None => self
                    .app
                    .say("usage: /effort none|minimal|low|medium|high|xhigh|max|off"),
            },
            "/export" if !arg.is_empty() => {
                let header = SessionHeader {
                    kind: "session".into(),
                    version: session::SESSION_VERSION,
                    id: session::new_id(),
                    timestamp: session::now_rfc3339(),
                    cwd: agent.config().cwd.display().to_string(),
                    provider: Some(self.provider.clone()),
                    model: Some(agent.config().model.clone()),
                };
                match session::export(Path::new(arg), &header, agent.messages()) {
                    Ok(()) => self.app.say(&format!("exported to {arg}")),
                    Err(e) => self.app.say(&format!("export failed: {e}")),
                }
            }
            _ => self.app.say("unknown command; /help lists them"),
        }
    }

    fn answer(&mut self, approval: Approval) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(approval);
        }
        self.app.pending = None;
    }

    fn key(&mut self, k: KeyEvent) {
        if k.kind != KeyEventKind::Press {
            return;
        }
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if self.app.pending.is_some() {
            match k.code {
                KeyCode::Char('y' | 'Y') => self.answer(Approval::Allow),
                KeyCode::Char('a' | 'A') => self.answer(Approval::AllowAlways),
                KeyCode::Char('n' | 'N') | KeyCode::Esc => self.answer(Approval::Deny { reason: None }),
                KeyCode::Char('c') if ctrl => {
                    self.answer(Approval::Deny { reason: None });
                    self.handle.abort();
                }
                _ => {}
            }
            return;
        }
        let running = self.task.is_some();
        let empty = self.app.input.lines().iter().all(String::is_empty);
        match k.code {
            KeyCode::Char('c') if ctrl => {
                if running {
                    self.handle.abort();
                } else if !empty {
                    self.app.input = App::new(String::new(), self.app.palette).input;
                } else {
                    self.app.quit = true;
                }
            }
            KeyCode::Char('d') if ctrl && empty && !running => self.app.quit = true,
            KeyCode::Esc if running => self.handle.abort(),
            KeyCode::Char('j') if ctrl => self.app.input.insert_newline(),
            KeyCode::Enter if k.modifiers.contains(KeyModifiers::SHIFT) => self.app.input.insert_newline(),
            KeyCode::Enter => {
                let text = self.app.input.lines().join("\n").trim().to_owned();
                if text.is_empty() {
                    return;
                }
                self.app.input = App::new(String::new(), self.app.palette).input;
                let alt = k.modifiers.contains(KeyModifiers::ALT);
                if running && alt {
                    self.handle.follow_up(text.clone());
                    self.app.say(&format!("queued: {text}"));
                } else if running {
                    self.handle.steer(text);
                } else if text.starts_with('/') {
                    self.command(&text);
                } else {
                    self.start(text);
                }
            }
            _ => {
                self.app.input.input(k);
            }
        }
    }
}

fn flush(term: &mut DefaultTerminal, app: &mut App) -> std::io::Result<()> {
    let ctx = |what: &'static str| move |e: std::io::Error| std::io::Error::new(e.kind(), format!("{what}: {e}"));
    let width = term.size().map_err(ctx("reading the terminal size"))?.width;
    app.set_width(width);
    let lines: Vec<Line<'static>> = app.take_scrollback();
    if !lines.is_empty() {
        let height = u16::try_from(lines.len()).unwrap_or(u16::MAX);
        term.insert_before(height, |buf| Paragraph::new(lines).render(buf.area, buf))
            .map_err(ctx("printing above the interface"))?;
    }
    term.draw(|f| app.draw(f)).map_err(ctx("drawing the interface"))?;
    Ok(())
}

/// Runs the interface until the user quits, and gives the agent back (with its conversation).
pub async fn run(agent: Agent, mut channels: Channels, opts: Options) -> std::io::Result<Agent> {
    let mut term = ratatui::try_init_with_options(TerminalOptions {
        viewport: Viewport::Inline(opts.height.max(8)),
    })?;
    let mut st = State {
        app: App::new(String::new(), opts.palette),
        handle: agent.handle(),
        agent: Some(agent),
        task: None,
        reply: None,
        provider: opts.provider,
    };
    st.app.model_label = st.label();
    st.app.say("aparte: Enter sends, /help lists commands, Ctrl+D quits.");
    let mut keys = EventStream::new();
    let result = loop {
        if let Err(e) = flush(&mut term, &mut st.app) {
            break Err(e);
        }
        if st.app.quit {
            break Ok(());
        }
        let running = st.task.is_some();
        tokio::select! {
            key = keys.next() => match key {
                Some(Ok(Event::Key(k))) => st.key(k),
                Some(Ok(Event::Paste(text))) => {
                    st.app.input.insert_str(text);
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => break Err(e),
                None => break Ok(()),
            },
            Some(ev) = channels.events.recv() => st.app.on_event(&ev),
            Some(ask) = channels.asks.recv() => {
                st.app.pending = Some(ask.request);
                st.reply = Some(ask.reply);
            }
            done = async {
                match st.task.as_mut() {
                    Some(t) => Some(t.await),
                    None => None,
                }
            }, if running => {
                st.task = None;
                match done {
                    Some(Ok((agent, _))) => st.agent = Some(agent),
                    Some(Err(e)) => {
                        st.app.say(&format!("the agent task failed: {e}"));
                        break Err(std::io::Error::other(e));
                    }
                    None => {}
                }
            }
        }
    };
    if let Some(task) = st.task.take() {
        st.handle.abort();
        if let Ok((agent, _)) = task.await {
            st.agent = Some(agent);
        }
    }
    while let Ok(ev) = channels.events.try_recv() {
        st.app.on_event(&ev);
    }
    let _ = flush(&mut term, &mut st.app);
    ratatui::restore();
    result?;
    st.agent.ok_or_else(|| std::io::Error::other("the agent was lost"))
}
