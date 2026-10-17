//! End-to-end tests of the `aparte` binary. Each test runs with its own HOME and directories so that nothing on the
//! developer's machine is read or written.

use assert_cmd::Command;
use predicates::prelude::*;

/// An `aparte` command isolated from the caller's environment.
fn aparte(home: &std::path::Path) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_aparte"));
    c.env("HOME", home)
        .env("APARTE_CONFIG_DIR", home.join("config"))
        .env("APARTE_DATA_DIR", home.join("data"))
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME")
        .env_remove("APARTE_LOG")
        .env("NO_COLOR", "1");
    c
}

fn home(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("aparte-cli-test-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temporary home");
    dir
}

#[test]
fn version_prints_the_crate_version() {
    aparte(&home("version"))
        .arg("--version")
        .assert()
        .success()
        .stdout(predicate::eq(format!("aparte {}\n", env!("CARGO_PKG_VERSION"))));
}

#[test]
fn selftest_passes_offline() {
    aparte(&home("selftest"))
        .arg("selftest")
        .assert()
        .code(0)
        .stdout(predicate::str::contains("all checks passed"));
}

#[test]
fn selftest_json_is_one_object_per_line() {
    let out = aparte(&home("selftest-json"))
        .args(["--json", "selftest"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8(out.stdout).expect("utf-8");
    let events: Vec<serde_json::Value> = stdout
        .lines()
        .map(|l| serde_json::from_str(l).expect("every stdout line is JSON"))
        .collect();
    let last = events.last().expect("at least one event");
    assert_eq!(last["event"], "selftest");
    assert_eq!(last["ok"], true);
}

#[test]
fn unknown_verb_is_a_usage_error() {
    aparte(&home("unknown")).arg("frobnicate").assert().code(2);
}

#[test]
fn doctor_reports_the_directories_in_use() {
    let h = home("doctor");
    aparte(&h)
        .args(["--json", "doctor"])
        .assert()
        .code(0)
        .stdout(predicate::str::contains(h.join("config").display().to_string()));
}

#[test]
fn completions_are_printed_for_bash() {
    aparte(&home("completions"))
        .args(["completions", "bash"])
        .assert()
        .success()
        .stdout(predicate::str::contains("aparte"));
}
