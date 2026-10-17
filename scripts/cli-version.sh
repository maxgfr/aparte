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

# The crates whose version is inherited from the workspace; each has a [[package]] entry in Cargo.lock.
CRATES=(aparte aparte-format aparte-crypto)

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
