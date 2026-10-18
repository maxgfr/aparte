//! The GitHub and S3 stores against in-memory fakes of their HTTP APIs (the requests the web app's providers make),
//! and the folder store: two CLI devices sync a vault through each, objects land in the layout of spec/FORMAT.md
//! section 10.5, and the credentials only ever travel in the authorization header.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use aparte_crypto::OsRng;
use aparte_crypto::primitives::sha256;
use aparte_crypto::text::parse_secret_key;
use aparte_format::encoding::to_hex;
use aparte_format::keyslot::Argon2Params;
use aparte_store::{CreateOptions, Credential, Vault};
use aparte_sync::join::read_stored_vault;
use aparte_sync::providers::b64;
use aparte_sync::providers::folder::FolderStore;
use aparte_sync::providers::github::{GitHubStore, GitHubTarget, Pacer};
use aparte_sync::providers::http::{Http, HttpRequest, HttpResponse};
use aparte_sync::providers::s3::{S3Store, S3Target};
use aparte_sync::providers::sigv4::{SigV4Input, sign_v4};
use aparte_sync::{Engine, NewConversation, NewMessage, RemoteStore, SystemClock, Workspace};
use async_trait::async_trait;
use serde_json::{Value, json};

const SMALL: Argon2Params = Argon2Params { m: 19456, t: 2, p: 1 };
const PASSPHRASE: &str = "providers passphrase";

fn respond(status: u16, body: Value) -> HttpResponse {
    HttpResponse {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: serde_json::to_vec(&body).expect("json"),
    }
}

// A fake GitHub: trees are flat maps of path -> blob id; enough of the Git Data and Contents APIs for the store.

#[derive(Default)]
struct GitHubState {
    blobs: BTreeMap<String, String>,
    trees: BTreeMap<String, BTreeMap<String, String>>,
    commits: BTreeMap<String, (String, Vec<String>, Value)>,
    refs: BTreeMap<String, String>,
    requests: Vec<HttpRequest>,
}

#[derive(Clone, Default)]
struct FakeGitHub {
    state: Arc<Mutex<GitHubState>>,
    token: String,
}

fn id_of(kind: &str, content: &str) -> String {
    to_hex(&sha256(format!("{kind}|{content}").as_bytes()))[..40].to_owned()
}

impl GitHubState {
    fn tree_json(&self, sha: &str) -> Option<Value> {
        let tree = self.trees.get(sha)?;
        let mut items = Vec::new();
        let mut dirs = std::collections::BTreeSet::new();
        for (path, blob) in tree {
            let parts: Vec<&str> = path.split('/').collect();
            for i in 1..parts.len() {
                dirs.insert(parts[..i].join("/"));
            }
            items.push(json!({"path": path, "type": "blob", "mode": "100644", "sha": blob}));
        }
        for d in dirs {
            items.push(json!({"path": d, "type": "tree", "mode": "040000", "sha": id_of("dir", &d)}));
        }
        Some(json!({"sha": sha, "tree": items, "truncated": false}))
    }

    fn put_tree(&mut self, tree: BTreeMap<String, String>) -> String {
        let sha = id_of("tree", &serde_json::to_string(&tree).expect("json"));
        self.trees.insert(sha.clone(), tree);
        sha
    }
}

#[async_trait]
impl Http for FakeGitHub {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        assert_eq!(
            request.header("authorization"),
            Some(format!("Bearer {}", self.token).as_str())
        );
        assert!(!request.url.contains(&self.token), "the token never travels in a URL");
        let mut s = self.state.lock().expect("lock");
        s.requests.push(request.clone());
        let path = request
            .url
            .strip_prefix("https://api.github.com/repos/owner/repo")
            .expect("repository URL")
            .trim_start_matches('/')
            .to_owned();
        let body: Value = request
            .body
            .as_deref()
            .map(|b| serde_json::from_slice(b).expect("json body"))
            .unwrap_or(Value::Null);
        let method = request.method.as_str();
        Ok(match (method, path.as_str()) {
            ("GET", "") => respond(200, json!({"default_branch": "main", "private": true, "size": 1})),
            ("GET", p) if p.starts_with("git/ref/heads/") => {
                let branch = &p["git/ref/heads/".len()..];
                if s.refs.is_empty() {
                    respond(409, json!({"message": "Git Repository is empty."}))
                } else if let Some(sha) = s.refs.get(branch) {
                    respond(200, json!({"object": {"sha": sha}}))
                } else {
                    respond(404, json!({"message": "Not Found"}))
                }
            }
            ("GET", p) if p.starts_with("git/trees/") => {
                let sha = p["git/trees/".len()..].split('?').next().expect("sha");
                let commit_tree = s.commits.get(sha).map(|c| c.0.clone());
                match s.tree_json(&commit_tree.unwrap_or_else(|| sha.to_owned())) {
                    Some(t) => respond(200, t),
                    None => respond(404, json!({"message": "Not Found"})),
                }
            }
            ("GET", p) if p.starts_with("git/blobs/") => match s.blobs.get(&p["git/blobs/".len()..]) {
                Some(content) => respond(
                    200,
                    json!({"content": b64::encode(content.as_bytes()), "encoding": "base64"}),
                ),
                None => respond(404, json!({"message": "Not Found"})),
            },
            ("PUT", p) if p.starts_with("contents/") => {
                if !s.refs.is_empty() {
                    return Ok(respond(422, json!({"message": "exists"})));
                }
                let file = p["contents/".len()..].to_owned();
                let text = String::from_utf8(b64::decode(body["content"].as_str().expect("content")).expect("b64"))
                    .expect("utf8");
                let blob = id_of("blob", &text);
                s.blobs.insert(blob.clone(), text);
                let tree = s.put_tree([(file, blob)].into());
                let commit = id_of("commit", &tree);
                s.commits.insert(commit.clone(), (tree, vec![], body["author"].clone()));
                s.refs
                    .insert(body["branch"].as_str().expect("branch").to_owned(), commit);
                respond(201, json!({}))
            }
            ("POST", "git/blobs") => {
                let content = body["content"].as_str().expect("content").to_owned();
                let sha = id_of("blob", &content);
                s.blobs.insert(sha.clone(), content);
                respond(201, json!({"sha": sha}))
            }
            ("POST", "git/trees") => {
                let base = body["base_tree"].as_str().expect("base");
                let base_tree = s
                    .commits
                    .get(base)
                    .map(|c| c.0.clone())
                    .unwrap_or_else(|| base.to_owned());
                let mut tree = s.trees.get(&base_tree).cloned().unwrap_or_default();
                for item in body["tree"].as_array().expect("items") {
                    let path = item["path"].as_str().expect("path").to_owned();
                    if let Some(content) = item["content"].as_str() {
                        let sha = id_of("blob", content);
                        s.blobs.insert(sha.clone(), content.to_owned());
                        tree.insert(path, sha);
                    } else if let Some(sha) = item["sha"].as_str() {
                        tree.insert(path, sha.to_owned());
                    } else {
                        tree.remove(&path);
                    }
                }
                let sha = s.put_tree(tree);
                respond(201, json!({"sha": sha}))
            }
            ("POST", "git/commits") => {
                let tree = body["tree"].as_str().expect("tree").to_owned();
                let parents: Vec<String> = body["parents"]
                    .as_array()
                    .expect("parents")
                    .iter()
                    .map(|p| p.as_str().expect("parent").to_owned())
                    .collect();
                assert_eq!(body["message"], "aparte: objects");
                let sha = id_of("commit", &format!("{tree}{parents:?}"));
                s.commits.insert(sha.clone(), (tree, parents, body["author"].clone()));
                respond(201, json!({"sha": sha}))
            }
            ("PATCH", p) if p.starts_with("git/refs/heads/") => {
                let branch = p["git/refs/heads/".len()..].to_owned();
                let sha = body["sha"].as_str().expect("sha").to_owned();
                let parent = s.commits.get(&sha).and_then(|c| c.1.first().cloned());
                if s.refs.get(&branch) != parent.as_ref() {
                    respond(422, json!({"message": "Update is not a fast forward"}))
                } else {
                    s.refs.insert(branch, sha);
                    respond(200, json!({}))
                }
            }
            _ => respond(404, json!({"message": format!("unexpected {method} {path}")})),
        })
    }
}

// A fake S3 bucket that checks every signature.

#[derive(Clone, Default)]
struct FakeS3 {
    objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
}

const KEY_ID: &str = "test-key-id";
const SECRET: &str = "test-secret";

fn query_param(url: &str, name: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == name).then(|| v.replace("%2F", "/"))
    })
}

#[async_trait]
impl Http for FakeS3 {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let auth = request.header("authorization").expect("signed");
        let datetime = request.header("x-amz-date").expect("dated");
        let extra: Vec<(&str, &str)> = request
            .headers
            .iter()
            .filter(|(k, _)| k == "content-type")
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let expected = sign_v4(&SigV4Input {
            method: &request.method,
            url: &request.url,
            headers: &extra,
            body: request.body.as_deref().unwrap_or_default(),
            region: "auto",
            service: "s3",
            datetime,
            access_key_id: KEY_ID,
            secret_access_key: SECRET,
            session_token: None,
        });
        assert!(
            auth.ends_with(&format!("Signature={}", expected.signature)),
            "a valid signature"
        );
        assert!(!request.url.contains(SECRET));
        let path = request
            .url
            .strip_prefix("http://127.0.0.1:9000/bucket")
            .expect("bucket URL")
            .split('?')
            .next()
            .expect("path")
            .trim_start_matches('/')
            .replace("%20", " ");
        let mut objects = self.objects.lock().expect("lock");
        Ok(match request.method.as_str() {
            "GET" if path.is_empty() => {
                let prefix = query_param(&request.url, "prefix").unwrap_or_default();
                let mut xml = String::from("<ListBucketResult><IsTruncated>false</IsTruncated>");
                for (k, v) in objects.iter().filter(|(k, _)| k.starts_with(&prefix)) {
                    xml.push_str(&format!("<Contents><Key>{k}</Key><Size>{}</Size></Contents>", v.len()));
                }
                xml.push_str("</ListBucketResult>");
                HttpResponse {
                    status: 200,
                    headers: vec![],
                    body: xml.into_bytes(),
                }
            }
            "GET" => match objects.get(&path) {
                Some(bytes) => HttpResponse {
                    status: 200,
                    headers: vec![],
                    body: bytes.clone(),
                },
                None => HttpResponse {
                    status: 404,
                    headers: vec![],
                    body: b"<Error><Code>NoSuchKey</Code></Error>".to_vec(),
                },
            },
            "PUT" => {
                objects.insert(path, request.body.clone().unwrap_or_default());
                HttpResponse {
                    status: 200,
                    headers: vec![],
                    body: vec![],
                }
            }
            "DELETE" => {
                objects.remove(&path);
                HttpResponse {
                    status: 204,
                    headers: vec![],
                    body: vec![],
                }
            }
            m => panic!("unexpected {m}"),
        })
    }
}

/// Device A creates a vault and a conversation and syncs to `a_store`; device B joins from `b_store` (the same
/// destination) and reads it; B answers and A reads that.
fn two_devices(dir: &Path, a_store: &dyn RemoteStore, b_store: &dyn RemoteStore) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let clock = Arc::new(SystemClock);
    let va = Arc::new(Vault::new(dir.join("a")).with_argon2(SMALL));
    let created = va
        .create(PASSPHRASE, CreateOptions::default(), &mut OsRng, Box::new(OsRng))
        .expect("create");
    let wa = Workspace::open(created.unlocked.store.clone(), clock.clone()).expect("workspace");
    let conv = wa
        .create_conversation(NewConversation {
            title: Some("Through a provider".into()),
            ..NewConversation::default()
        })
        .expect("conversation");
    let m = wa.new_id().expect("id");
    wa.commit_message(
        &conv,
        &NewMessage::new(&m, None, "user", vec![json!({"type": "text", "text": "hi"})]),
    )
    .expect("message");
    wa.set_leaf(&conv, Some(&m), None).expect("leaf");
    let ea = Engine::new(created.unlocked.store.clone(), va.clone(), clock.clone());
    let r = rt.block_on(ea.round(a_store, false, Some(&wa))).expect("round A");
    assert!(r.up >= 5, "{r:?}");

    let vb = Arc::new(Vault::new(dir.join("b")).with_argon2(SMALL));
    let stored = rt.block_on(read_stored_vault(b_store)).expect("stored");
    vb.join(&stored.vault, &stored.keyslots).expect("join");
    let sk = parse_secret_key(created.secret_key.as_deref().expect("kit")).expect("kit");
    let ub = vb
        .unlock(
            &Credential::Passphrase {
                passphrase: PASSPHRASE,
                secret_key: Some(&sk),
            },
            Box::new(OsRng),
        )
        .expect("unlock");
    let wb = Workspace::open(ub.store.clone(), clock.clone()).expect("workspace");
    let eb = Engine::new(ub.store.clone(), vb.clone(), clock);
    let r = rt.block_on(eb.round(b_store, false, Some(&wb))).expect("round B");
    assert!(r.alarms.is_empty(), "{:?}", r.alarms);
    assert_eq!(wb.path(&conv, None).expect("path").len(), 1);
    let answer = wb.new_id().expect("id");
    let mut reply = NewMessage::new(
        &answer,
        Some(m.clone()),
        "assistant",
        vec![json!({"type": "text", "text": "hello"})],
    );
    reply.model = Some(aparte_sync::ModelRef {
        provider: "p".into(),
        id: "m".into(),
    });
    wb.commit_message(&conv, &reply).expect("reply");
    wb.set_leaf(&conv, Some(&answer), Some(Some(&m))).expect("leaf");
    rt.block_on(eb.round(b_store, false, Some(&wb))).expect("round B again");
    let r = rt.block_on(ea.round(a_store, false, Some(&wa))).expect("round A again");
    assert!(r.alarms.is_empty(), "{:?}", r.alarms);
    let path = wa.path(&conv, None).expect("path");
    assert_eq!(
        path.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        ["user", "assistant"]
    );
}

#[test]
fn the_github_store_carries_a_vault_between_devices() {
    let dir = tempfile::tempdir().expect("tempdir");
    let fake = FakeGitHub {
        token: "test-token-value".into(),
        ..FakeGitHub::default()
    };
    let target = GitHubTarget {
        owner: "owner".into(),
        repo: "repo".into(),
        branch: None,
        root: None,
        api_base: None,
    };
    let pacer = Arc::new(Pacer::new(60_000, 100_000));
    let a = GitHubStore::new(&target, "test-token-value", Arc::new(fake.clone()), pacer.clone());
    let b = GitHubStore::new(&target, "test-token-value", Arc::new(fake.clone()), pacer);
    two_devices(dir.path(), &a, &b);
    let s = fake.state.lock().expect("lock");
    let head = s.refs.get("main").expect("main");
    let (tree, _, author) = &s.commits[head];
    assert_eq!(author["name"], "aparte");
    let files = &s.trees[tree];
    assert!(
        files.contains_key("aparte/README.md"),
        "the first commit adds the README"
    );
    let fmt = &s.blobs[&files["aparte/fmt/1"]];
    assert_eq!(
        b64::decode(fmt).as_deref(),
        Some(&b"aparte/1\n"[..]),
        "objects are base64 files"
    );
    assert!(files.keys().all(|p| p.starts_with("aparte/")));
}

#[test]
fn the_s3_store_carries_a_vault_between_devices() {
    let dir = tempfile::tempdir().expect("tempdir");
    let fake = FakeS3::default();
    let target = S3Target {
        endpoint: "http://127.0.0.1:9000".into(),
        region: "auto".into(),
        bucket: "bucket".into(),
        prefix: Some("vault".into()),
        access_key_id: KEY_ID.into(),
        secret_access_key: SECRET.into(),
    };
    let a = S3Store::new(target.clone(), Arc::new(fake.clone()));
    let b = S3Store::new(target, Arc::new(fake.clone()));
    two_devices(dir.path(), &a, &b);
    let objects = fake.objects.lock().expect("lock");
    assert_eq!(objects.get("vault/fmt/1").map(Vec::as_slice), Some(&b"aparte/1\n"[..]));
    assert!(objects.keys().all(|k| k.starts_with("vault/")));
}

#[test]
fn the_folder_store_carries_a_vault_between_devices() {
    let dir = tempfile::tempdir().expect("tempdir");
    let folder = dir.path().join("shared");
    std::fs::create_dir_all(&folder).expect("dir");
    let a = FolderStore::new(&folder, "shared");
    let b = FolderStore::new(&folder, "shared");
    two_devices(dir.path(), &a, &b);
    assert_eq!(std::fs::read(folder.join("fmt/1")).expect("marker"), b"aparte/1\n");
    let missing = FolderStore::new(dir.path().join("unmounted"), "gone");
    let rt = tokio::runtime::Builder::new_current_thread().build().expect("runtime");
    let err = rt.block_on(missing.list()).unwrap_err();
    assert_eq!(
        err.kind,
        aparte_sync::RemoteErrorKind::NotFound,
        "a missing folder is no empty store"
    );
}
