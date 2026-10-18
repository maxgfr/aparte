//! Output: human text or NDJSON events. With `--json`, stdout carries only JSON objects (one per line) and every
//! human message goes to stderr, so the output can be piped into a parser.

use std::io::{IsTerminal, Write};

use serde_json::{Map, Value};

/// Where and how a verb reports.
#[derive(Clone)]
pub struct Ui {
    json: bool,
    quiet: bool,
    color: bool,
}

impl Ui {
    /// An output for the global `--json` and `--quiet` flags.
    pub fn new(json: bool, quiet: bool) -> Ui {
        let color = std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none();
        Ui { json, quiet, color }
    }

    /// Whether events are printed as JSON.
    pub fn is_json(&self) -> bool {
        self.json
    }

    /// Prints a JSON event `{"event": <event>, ...fields}` on stdout; does nothing without `--json`.
    pub fn emit(&self, event: &str, fields: Value) {
        if !self.json {
            return;
        }
        let mut obj = Map::new();
        obj.insert("event".into(), Value::String(event.into()));
        if let Value::Object(f) = fields {
            obj.extend(f);
        }
        let mut out = std::io::stdout().lock();
        // A closed pipe (`aparte ... | head`) is not an error worth a panic.
        let _ = writeln!(out, "{}", Value::Object(obj));
    }

    /// Prints a line of human text: stdout normally, stderr with `--json`, nothing with `--quiet`.
    pub fn say(&self, text: &str) {
        if self.quiet {
            return;
        }
        if self.json {
            eprintln!("{text}");
        } else {
            let _ = writeln!(std::io::stdout().lock(), "{text}");
        }
    }

    /// Reports an error on stderr, and as an `error` event with `--json`.
    pub fn error(&self, code: u8, message: &str) {
        self.emit("error", serde_json::json!({ "code": code, "message": message }));
        eprintln!("aparte: {message}");
    }

    /// One line of a check list (selftest, doctor).
    pub fn check(&self, name: &str, ok: bool, detail: &str) {
        self.emit("check", serde_json::json!({ "name": name, "ok": ok, "detail": detail }));
        let mark = match (ok, self.color) {
            (true, true) => "\x1b[32mok\x1b[0m",
            (false, true) => "\x1b[31mFAIL\x1b[0m",
            (true, false) => "ok",
            (false, false) => "FAIL",
        };
        self.say(&format!("{mark:>4}  {name}: {detail}"));
    }
}
