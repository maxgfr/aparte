//! The sync stores: a folder, a Git repository through the `git` binary, a Git repository through the GitHub API,
//! an S3-compatible bucket, and an in-memory store for tests. Their layouts are those of spec/FORMAT.md section 10.5,
//! so each one interoperates with the web app's provider of the same kind.

pub mod b64;
pub mod folder;
pub mod git;
pub mod github;
pub mod http;
pub mod memory;
pub mod s3;
pub mod sigv4;

/// The README the first commit of an empty Git repository adds under the store's root (spec/FORMAT.md section 10.5),
/// the same text as the web app's.
pub const README_TEXT: &str = "This folder holds an Aparté vault: encrypted objects in the aparte/1 format.\n\n\
Do not edit, move or delete these files: the devices that sync here would no longer read them.\n";
/// The one commit message every Git write uses.
pub const COMMIT_MESSAGE: &str = "aparte: objects";
/// The one author and committer name of every Git write.
pub const COMMIT_NAME: &str = "aparte";
/// The one author and committer email of every Git write.
pub const COMMIT_EMAIL: &str = "aparte@users.noreply.github.com";
/// The default folder of a Git repository that holds the store.
pub const DEFAULT_ROOT: &str = "aparte";

/// A Git store's root folder: trimmed of slashes, `aparte` when empty.
pub fn git_root(root: Option<&str>) -> String {
    let trimmed = root.unwrap_or_default().trim().trim_matches('/');
    if trimmed.is_empty() {
        DEFAULT_ROOT.to_owned()
    } else {
        trimmed.to_owned()
    }
}
