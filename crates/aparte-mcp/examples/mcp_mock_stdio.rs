//! A small MCP server on stdin and stdout, for trying `aparte mcp` and for the tests:
//!
//! ```sh
//! cargo build -p aparte-mcp --example mcp_mock_stdio
//! aparte mcp add mock target/debug/examples/mcp_mock_stdio
//! aparte mcp tools mock
//! ```
//!
//! `APARTE_MOCK_VARIANT=2` changes a tool's description and adds one (to see pinning hold them back).
//! `APARTE_MOCK_CHILD_PID_FILE=<file>` starts a helper process and writes its pid there (to see the process group
//! killed on exit).

use aparte_mcp::mock::{MockOptions, serve_stdio};

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::io::Result<()> {
    let variant = std::env::var("APARTE_MOCK_VARIANT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    if let Some(file) = std::env::var_os("APARTE_MOCK_CHILD_PID_FILE") {
        let child = std::process::Command::new("sleep")
            .arg("600")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        std::fs::write(file, child.id().to_string())?;
    }
    eprintln!("mock MCP server ready (variant {variant})");
    serve_stdio(MockOptions { variant, oauth: false }).await
}
