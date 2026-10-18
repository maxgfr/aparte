//! `aparte-mcp`: the Model Context Protocol client of the `aparte` agent, on `rmcp`.
//!
//! - [`config`]: the `mcpServers` files, in the shape Claude and Cursor use (`<config>/mcp.json`, and the project's
//!   `.aparte/mcp.json` when the project is trusted).
//! - [`client`]: stdio servers in their own process group (killed as a group on exit), Streamable HTTP servers over
//!   rustls, and their tools as [`aparte_agent::Tool`]s whose MCP annotations drive approvals.
//! - [`pins`]: tool definitions pinned by fingerprint; a tool that changes after approval is held back.
//! - [`auth`]: OAuth 2.1 with PKCE and a loopback redirect, tokens encrypted under a key in the OS keychain.
//! - [`mock`]: a small MCP server for tests and examples.

pub mod auth;
pub mod client;
pub mod config;
pub mod mock;
pub mod pins;

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
    Io(#[from] std::io::Error),
}
