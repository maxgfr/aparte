//! The `mcpServers` configuration, in the JSON shape Claude and Cursor use, so a file can be copied between them:
//!
//! ```json
//! {
//!   "mcpServers": {
//!     "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "env": {} },
//!     "docs": { "type": "http", "url": "https://example.com/mcp", "headers": { "X-Team": "${TEAM}" } }
//!   }
//! }
//! ```
//!
//! - A server with `command` is a stdio server; one with `url` is a Streamable HTTP server (`type` may say `stdio`
//!   or `http`; `streamable-http` is read as `http`; the legacy `sse` transport is refused).
//! - `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `url` and `headers` are read from the environment
//!   when the server starts, so tokens can stay out of the file.
//! - `disabled: true` keeps a server in the file without starting it. `oauth` (`clientId`, `scopes`) presets the
//!   OAuth client of an HTTP server; without it the client registers itself (dynamic client registration).
//!
//! Files: `<config>/mcp.json` for the user, and `.aparte/mcp.json` in the project (the nearest one from the working
//! directory up), read only when the project is trusted. A project server replaces a user server of the same name.
//! The files are written 0600, atomically, and keys this crate does not know are kept.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Why a configuration could not be used.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read or write {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{path} is not valid JSON: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("server {name:?} in {path}: {message}")]
    Server {
        path: PathBuf,
        name: String,
        message: String,
    },
    #[error("{0}")]
    Invalid(String),
}

/// Preset OAuth client of an HTTP server.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthConfig {
    /// A client registered beforehand with the authorization server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// Scopes to ask for (default: what the server advertises).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<String>,
}

/// How to reach a server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transport {
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        cwd: Option<PathBuf>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, String>,
        oauth: Option<OAuthConfig>,
    },
}

/// Where a server was configured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    User,
    Project,
}

impl Source {
    /// A name for listings.
    pub fn name(self) -> &'static str {
        match self {
            Source::User => "user",
            Source::Project => "project",
        }
    }
}

/// One configured server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub name: String,
    pub transport: Transport,
    pub disabled: bool,
    pub source: Source,
    /// The file it was read from.
    pub file: PathBuf,
}

/// Whether a server name can be used: 1 to 64 ASCII letters, digits, `-` and `_`.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn strings(v: Option<&Value>) -> Result<Vec<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| match i {
                Value::String(s) => Ok(s.clone()),
                Value::Number(n) => Ok(n.to_string()),
                Value::Bool(b) => Ok(b.to_string()),
                _ => Err("`args` must be a list of strings".to_owned()),
            })
            .collect(),
        Some(_) => Err("`args` must be a list of strings".into()),
    }
}

fn string_map(v: Option<&Value>, what: &str) -> Result<BTreeMap<String, String>, String> {
    match v {
        None | Some(Value::Null) => Ok(BTreeMap::new()),
        Some(Value::Object(m)) => m
            .iter()
            .map(|(k, v)| match v {
                Value::String(s) => Ok((k.clone(), s.clone())),
                Value::Number(n) => Ok((k.clone(), n.to_string())),
                Value::Bool(b) => Ok((k.clone(), b.to_string())),
                _ => Err(format!("`{what}` values must be strings")),
            })
            .collect(),
        Some(_) => Err(format!("`{what}` must be an object of strings")),
    }
}

/// Reads one server entry.
pub fn parse_server(name: &str, v: &Value, source: Source, file: &Path) -> Result<ServerConfig, ConfigError> {
    let fail = |message: String| ConfigError::Server {
        path: file.to_path_buf(),
        name: name.to_owned(),
        message,
    };
    if !valid_name(name) {
        return Err(fail("a name is 1 to 64 letters, digits, `-` or `_`".into()));
    }
    let obj = v.as_object().ok_or_else(|| fail("an entry must be an object".into()))?;
    let kind = obj.get("type").and_then(Value::as_str).map(str::to_ascii_lowercase);
    let disabled = obj.get("disabled").and_then(Value::as_bool).unwrap_or(false);
    let transport = match (kind.as_deref(), obj.get("command"), obj.get("url")) {
        (Some("sse"), _, _) => {
            return Err(fail(
                "the legacy SSE transport is not supported; use the server's Streamable HTTP endpoint (`type: http`)"
                    .into(),
            ));
        }
        (None | Some("stdio"), Some(Value::String(command)), _) => Transport::Stdio {
            command: command.clone(),
            args: strings(obj.get("args")).map_err(fail)?,
            env: string_map(obj.get("env"), "env").map_err(fail)?,
            cwd: obj.get("cwd").and_then(Value::as_str).map(PathBuf::from),
        },
        (None | Some("http" | "streamable-http" | "streamablehttp"), _, Some(Value::String(url))) => {
            let oauth = match obj.get("oauth") {
                None | Some(Value::Null) => None,
                Some(o) => {
                    Some(serde_json::from_value::<OAuthConfig>(o.clone()).map_err(|e| fail(format!("`oauth`: {e}")))?)
                }
            };
            Transport::Http {
                url: url.clone(),
                headers: string_map(obj.get("headers"), "headers").map_err(fail)?,
                oauth,
            }
        }
        (Some(other), _, _) if !matches!(other, "stdio" | "http" | "streamable-http" | "streamablehttp") => {
            return Err(fail(format!("unknown transport type {other:?}")));
        }
        _ => return Err(fail("needs a `command` (stdio) or a `url` (http)".into())),
    };
    Ok(ServerConfig {
        name: name.to_owned(),
        transport,
        disabled,
        source,
        file: file.to_path_buf(),
    })
}

/// A configuration file, kept as JSON so that unknown keys survive an edit.
#[derive(Debug, Clone)]
pub struct ConfigFile {
    pub path: PathBuf,
    pub source: Source,
    doc: Value,
}

impl ConfigFile {
    /// Reads a file; a missing one is empty.
    pub fn load(path: &Path, source: Source) -> Result<ConfigFile, ConfigError> {
        let doc = match std::fs::read(path) {
            Ok(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => Value::Object(Map::new()),
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|source| ConfigError::Json {
                path: path.to_path_buf(),
                source,
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Object(Map::new()),
            Err(source) => {
                return Err(ConfigError::Io {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };
        if !doc.is_object() {
            return Err(ConfigError::Invalid(format!(
                "{} must hold a JSON object",
                path.display()
            )));
        }
        Ok(ConfigFile {
            path: path.to_path_buf(),
            source,
            doc,
        })
    }

    fn servers_obj(&self) -> Option<&Map<String, Value>> {
        self.doc.get("mcpServers").and_then(Value::as_object)
    }

    /// The servers of this file, in name order; an entry that does not parse is an error.
    pub fn servers(&self) -> Result<Vec<ServerConfig>, ConfigError> {
        let Some(map) = self.servers_obj() else {
            return Ok(Vec::new());
        };
        let mut names: Vec<&String> = map.keys().collect();
        names.sort();
        names
            .into_iter()
            .map(|n| parse_server(n, &map[n], self.source, &self.path))
            .collect()
    }

    /// Whether the file has a server of this name.
    pub fn contains(&self, name: &str) -> bool {
        self.servers_obj().is_some_and(|m| m.contains_key(name))
    }

    /// Adds or replaces a server entry (checked before it is written).
    pub fn upsert(&mut self, name: &str, entry: Value) -> Result<(), ConfigError> {
        parse_server(name, &entry, self.source, &self.path)?;
        let root = self
            .doc
            .as_object_mut()
            .ok_or_else(|| ConfigError::Invalid("not an object".into()))?;
        let servers = root.entry("mcpServers").or_insert_with(|| Value::Object(Map::new()));
        if !servers.is_object() {
            *servers = Value::Object(Map::new());
        }
        if let Value::Object(m) = servers {
            m.insert(name.to_owned(), entry);
        }
        Ok(())
    }

    /// Removes a server entry; true when there was one.
    pub fn remove(&mut self, name: &str) -> bool {
        self.doc
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .is_some_and(|m| m.remove(name).is_some())
    }

    /// Writes the file atomically, 0600, in a 0700 directory.
    pub fn save(&self) -> Result<(), ConfigError> {
        let io = |source| ConfigError::Io {
            path: self.path.clone(),
            source,
        };
        if let Some(parent) = self.path.parent() {
            aparte_agent::fsx::private_dir(parent).map_err(io)?;
        }
        let mut bytes = serde_json::to_vec_pretty(&self.doc).map_err(|source| ConfigError::Json {
            path: self.path.clone(),
            source,
        })?;
        bytes.push(b'\n');
        aparte_agent::fsx::atomic_write(&self.path, &bytes, 0o600).map_err(io)
    }
}

/// The user file: `<config_dir>/mcp.json`.
pub fn user_file(config_dir: &Path) -> PathBuf {
    config_dir.join("mcp.json")
}

/// The project file that applies to `cwd`: the nearest `.aparte/mcp.json` from `cwd` up, else `cwd/.aparte/mcp.json`
/// (where a new one goes).
pub fn project_file(cwd: &Path) -> PathBuf {
    cwd.ancestors()
        .map(|d| d.join(".aparte/mcp.json"))
        .find(|p| p.is_file())
        .unwrap_or_else(|| cwd.join(".aparte/mcp.json"))
}

/// The servers that apply: the user's, then the project's when it is trusted (replacing user servers of the same
/// name). Errors in one entry are returned beside the servers that did load.
pub fn load(config_dir: Option<&Path>, cwd: &Path, trusted: bool) -> (Vec<ServerConfig>, Vec<ConfigError>) {
    let mut out: Vec<ServerConfig> = Vec::new();
    let mut errors = Vec::new();
    let mut files = Vec::new();
    if let Some(dir) = config_dir {
        files.push((user_file(dir), Source::User));
    }
    if trusted {
        files.push((project_file(cwd), Source::Project));
    }
    for (path, source) in files {
        let file = match ConfigFile::load(&path, source) {
            Ok(f) => f,
            Err(e) => {
                errors.push(e);
                continue;
            }
        };
        let Some(map) = file.servers_obj() else {
            continue;
        };
        let mut names: Vec<&String> = map.keys().collect();
        names.sort();
        for name in names {
            match parse_server(name, &map[name], source, &path) {
                Ok(s) => {
                    out.retain(|o| o.name != s.name);
                    out.push(s);
                }
                Err(e) => errors.push(e),
            }
        }
    }
    (out, errors)
}

/// Fills `${VAR}` and `${VAR:-default}` from `lookup`; an unset variable without a default is an error.
pub fn expand(s: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find('}').ok_or_else(|| format!("an unclosed `${{` in {s:?}"))?;
        let inner = &after[..end];
        let (var, default) = match inner.split_once(":-") {
            Some((v, d)) => (v, Some(d)),
            None => (inner, None),
        };
        let valid = !var.is_empty() && var.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !valid {
            return Err(format!("`${{{inner}}}` is not a variable reference"));
        }
        match (lookup(var).filter(|v| !v.is_empty()), default) {
            (Some(v), _) => out.push_str(&v),
            (None, Some(d)) => out.push_str(d),
            (None, None) => return Err(format!("the environment variable {var} is not set")),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Expansion from the process environment.
pub fn expand_env(s: &str) -> Result<String, String> {
    expand(s, &|v| std::env::var(v).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_and_cursor_entries_parse() {
        let f = Path::new("/x/mcp.json");
        let s = parse_server(
            "files",
            &json!({"command": "npx", "args": ["-y", "srv", 3], "env": {"A": "1"}}),
            Source::User,
            f,
        )
        .expect("stdio");
        assert!(matches!(&s.transport, Transport::Stdio { command, args, env, .. }
            if command == "npx" && args == &["-y", "srv", "3"] && env["A"] == "1"));
        let h = parse_server(
            "docs",
            &json!({"type": "http", "url": "https://e.com/mcp", "headers": {"X": "y"}, "oauth": {"clientId": "c", "scopes": ["a"]}}),
            Source::User,
            f,
        )
        .expect("http");
        assert!(
            matches!(&h.transport, Transport::Http { url, oauth: Some(o), .. } if url == "https://e.com/mcp" && o.client_id.as_deref() == Some("c"))
        );
        let cursor = parse_server("c", &json!({"url": "http://127.0.0.1:9/mcp"}), Source::User, f).expect("cursor");
        assert!(matches!(cursor.transport, Transport::Http { .. }));
        assert!(
            parse_server(
                "s",
                &json!({"type": "sse", "url": "https://e.com/sse"}),
                Source::User,
                f
            )
            .is_err()
        );
        assert!(parse_server("bad name", &json!({"command": "x"}), Source::User, f).is_err());
        assert!(parse_server("n", &json!({"args": []}), Source::User, f).is_err());
        assert!(parse_server("n", &json!({"type": "ws", "url": "x"}), Source::User, f).is_err());
    }

    #[test]
    fn variables_expand_from_the_environment() {
        let env = |v: &str| (v == "TOKEN").then(|| "abc".to_owned());
        assert_eq!(expand("Bearer ${TOKEN}", &env).expect("ok"), "Bearer abc");
        assert_eq!(expand("${MISSING:-dflt}/x", &env).expect("ok"), "dflt/x");
        assert!(expand("${MISSING}", &env).is_err());
        assert!(expand("${TOKEN", &env).is_err());
        assert_eq!(expand("no vars $HOME", &env).expect("ok"), "no vars $HOME");
    }

    #[test]
    fn edits_keep_unknown_keys_and_project_files_need_trust() {
        let cfg = tempfile::tempdir().expect("cfg");
        let proj = tempfile::tempdir().expect("proj");
        let path = user_file(cfg.path());
        std::fs::write(&path, r#"{"other": 1, "mcpServers": {"a": {"command": "x"}}}"#).expect("write");
        let mut f = ConfigFile::load(&path, Source::User).expect("load");
        f.upsert("b", json!({"url": "https://e.com/mcp"})).expect("upsert");
        assert!(
            f.upsert("c", json!({"nothing": true})).is_err(),
            "checked before it is written"
        );
        assert!(f.remove("a") && !f.remove("a"));
        f.save().expect("save");
        let text = std::fs::read_to_string(&path).expect("read");
        assert!(text.contains("\"other\": 1") && text.contains("\"b\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let fresh = cfg.path().join("new/mcp.json");
            let mut n = ConfigFile::load(&fresh, Source::User).expect("empty");
            n.upsert("x", json!({"command": "x"})).expect("upsert");
            n.save().expect("save");
            assert_eq!(
                std::fs::metadata(&fresh).expect("meta").permissions().mode() & 0o777,
                0o600
            );
        }
        let pfile = proj.path().join(".aparte/mcp.json");
        std::fs::create_dir_all(pfile.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &pfile,
            r#"{"mcpServers": {"b": {"command": "local"}, "p": {"command": "y"}}}"#,
        )
        .expect("write");
        let sub = proj.path().join("deep");
        std::fs::create_dir_all(&sub).expect("mkdir");
        let (untrusted, errs) = load(Some(cfg.path()), &sub, false);
        assert!(errs.is_empty());
        assert_eq!(untrusted.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["b"]);
        assert!(matches!(untrusted[0].transport, Transport::Http { .. }));
        let (trusted, _) = load(Some(cfg.path()), &sub, true);
        let names: Vec<_> = trusted.iter().map(|s| (s.name.as_str(), s.source)).collect();
        assert_eq!(names, [("b", Source::Project), ("p", Source::Project)]);
    }
}
