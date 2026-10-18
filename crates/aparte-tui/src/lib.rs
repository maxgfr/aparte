//! `aparte-tui`: the terminal interface of the `aparte` agent, on ratatui with an inline viewport, so that the
//! conversation stays in the terminal's scrollback.
//!
//! - [`markdown`]: Markdown to styled lines, code highlighted with syntect.
//! - [`app`]: the interface state and drawing, testable without a terminal.
//! - [`run`]: the terminal loop, and the channels that connect it to an [`aparte_agent::Agent`].

pub mod app;
pub mod markdown;
pub mod run;

pub use markdown::Palette;
pub use run::{ChannelApprover, Channels, Options, channels, run};
