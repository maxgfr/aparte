//! `aparte-mcp`: the Model Context Protocol client of the `aparte` agent, on `rmcp`.
//!
//! - [`config`]: the `mcpServers` files, in the shape Claude and Cursor use (`<config>/mcp.json`, and the project's
//!   `.aparte/mcp.json` when the project is trusted).
//! - [`client`]: stdio servers in their own process group (killed as a group on exit), Streamable HTTP servers over
//!   rustls, and their tools as [`aparte_agent::Tool`]s whose MCP annotations drive approvals.
//! - [`pins`]: tool definitions pinned by fingerprint; a tool that changes after approval is held back.
//! - [`auth`]: OAuth 2.1 with PKCE and a loopback redirect, tokens encrypted under a key in the OS keychain.
//! - [`mock`]: a small MCP server for tests and examples.
//! - [`loopback`]: the guarded HTTP server on `127.0.0.1` of `aparte mcp serve` and `aparte mcp bridge`: Host and
//!   Origin allowlists, CORS for the web app, a hand-typed 256-bit bearer token (`spec/MCP-BRIDGE.md`).
//! - [`serve`]: the CLI's own tools offered to MCP clients, read-only ones by default, the others approved in the
//!   terminal call by call.
//! - [`bridge`]: configured servers (stdio, or HTTP without CORS) relayed to the web app, one endpoint each.

pub mod auth;
pub mod bridge;
pub mod client;
pub mod config;
pub mod loopback;
pub mod mock;
pub mod pins;
pub mod serve;

pub use client::{ConnectOptions, Connection, McpManager, McpTool, ServerState, ServerStatus, connect};
pub use config::{ConfigError, ServerConfig, Source, Transport};
pub use pins::{PinError, PinStatus, PinStore};

/// What can go wrong with MCP servers.
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Pins(#[from] PinError),
    #[error("{server}: {message}")]
    Server { server: String, message: String },
    #[error("{server} asks for authorization: run `aparte mcp login {server}`")]
    NeedsLogin { server: String },
    #[error("authorization: {0}")]
    Auth(String),
    #[error(transparent)]
    Loopback(#[from] loopback::LoopbackError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
