# Aparté

Private AI chat that runs entirely in your browser. Bring your own keys or run models on the device; conversations
and photos are encrypted on the device and synced end-to-end to storage you own. No account, no server.

- App: <https://maxgfr.github.io/aparte/>
- Interface language: English.
- Status: preview. The storage and sync format is not frozen yet; do not rely on it for data you cannot lose.

## Development

The web app lives in `web/` (Bun, Vite, React) and the CLI in `crates/` (Rust).

```sh
cd web && bun install && bun run dev      # http://localhost:5173/aparte/
cd web && bun run check                   # types, lint, tests, build, security scan, size budget
scripts/check.sh                          # Rust: fmt, clippy, tests, cargo deny
```

## License

[MIT](LICENSE)
