#!/usr/bin/env bash
# Sets the workspace version (the `version` line of [workspace.package] in Cargo.toml) and the version of every
# workspace crate in Cargo.lock, so that `cargo build --locked` still accepts the lockfile.
# The release workflow runs it before compiling, so the binary reports the version it is released under.
# Usage: scripts/cli-version.sh <semver>
set -euo pipefail

version="${1:?usage: scripts/cli-version.sh <version>}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] ||
  { echo "not a semver version: $version" >&2; exit 1; }

cd "$(dirname "$0")/.."

# The crates whose version is inherited from the workspace (`version.workspace = true`); each has a [[package]]
# entry in Cargo.lock. Read from the manifests, so a new crate is stamped without editing this script.
CRATES=()
for manifest in crates/*/Cargo.toml; do
  grep -qx 'version.workspace = true' "$manifest" || continue
  name=$(awk -F'"' '/^name = /{ print $2; exit }' "$manifest")
  [[ -n "$name" ]] || { echo "no package name in $manifest" >&2; exit 1; }
  CRATES+=("$name")
done
(( ${#CRATES[@]} > 0 )) || { echo "no workspace crate found" >&2; exit 1; }

# Rewrites the first `version = ...` line that follows a line equal to `after`, and fails if there is none.
set_version() {
  local file=$1 after=$2
  awk -v v="$version" -v after="$after" '
    armed && !done && /^version = / { $0 = "version = \"" v "\""; done = 1 }
    $0 == after { armed = 1 }
    { print }
    END { exit !done }' "$file" > "$file.tmp" ||
    { rm -f "$file.tmp"; echo "no version line after '$after' in $file" >&2; exit 1; }
  mv "$file.tmp" "$file"
}

set_version Cargo.toml '[workspace.package]'
for crate in "${CRATES[@]}"; do
  set_version Cargo.lock "name = \"$crate\""
done
echo "aparte version set to $version"
