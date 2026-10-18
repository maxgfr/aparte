//! A small MCP server over Streamable HTTP on a free loopback port; prints its URL and serves until interrupted.
//!
//! ```sh
//! cargo run -p aparte-mcp --example mcp_mock_http -- --oauth
//! aparte mcp add mock http://127.0.0.1:<port>/mcp
//! aparte mcp login mock
//! ```
//!
//! `--oauth` demands an OAuth login (the authorization step approves at once); `--variant 2` changes a tool.

use aparte_mcp::mock::{MockOptions, serve_http};

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let oauth = args.iter().any(|a| a == "--oauth");
    let variant = args
        .iter()
        .position(|a| a == "--variant")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let mock = serve_http(MockOptions { variant, oauth }).await?;
    println!("{}", mock.url());
    tokio::signal::ctrl_c().await
}
