#!/usr/bin/env bash
# The cross-implementation gate of the aparte/1 vectors (spec/vectors/README.md).
# 1. Regenerates the TypeScript reference vectors into spec/vectors and fails when they differ from the committed
#    files, or when a generated file is not committed.
# 2. Runs the Rust generator into a temporary directory and compares every generated file with the TypeScript one,
#    after `jq -S` (member order and whitespace are not compared, every name and value is).
# 3. Checks that the frozen fixtures of spec/fixtures are committed and unchanged, and that both implementations read
#    them back (spec/fixtures/README.md), the CLI's sync layer included (documents, join, photo).
# 4. Runs the mixed end-to-end gate (scripts/check-interop.sh): the reference and the CLI sync one vault both ways
#    through a local Git repository.
# Exits non-zero with a unified diff on any mismatch. CI runs this script as is.
# Usage: scripts/check-vectors.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/check-vectors.sh" >&2
  exit 2
fi

for tool in bun cargo jq git diff; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "check-vectors: $tool is required but not installed" >&2
    exit 1
  fi
done

VECTORS=spec/vectors

printf '==> TypeScript reference vectors\n'
# Generated files are removed first, so a file the generator no longer writes shows up as deleted in the diff.
find "$VECTORS" -maxdepth 1 -type f -name '*.json' ! -name inputs.json -delete
(cd web && bun scripts/vectors.ts)

# The generated files are every JSON file of the directory except the hand-written inputs.
FILES=()
while IFS= read -r file; do
  FILES+=("$file")
done < <(find "$VECTORS" -maxdepth 1 -type f -name '*.json' ! -name inputs.json -exec basename {} \; | LC_ALL=C sort)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "check-vectors: the TypeScript generator wrote no file into $VECTORS" >&2
  exit 1
fi

untracked="$(git ls-files --others --exclude-standard -- "$VECTORS")"
if [ -n "$untracked" ]; then
  printf '\ncheck-vectors: generated vectors are not committed:\n%s\n' "$untracked" >&2
  echo "Run \`bun web/scripts/vectors.ts\` and commit spec/vectors." >&2
  exit 1
fi
if ! git diff --exit-code -- "$VECTORS"; then
  printf '\ncheck-vectors: spec/vectors differs from the TypeScript reference output (diff above).\n' >&2
  echo "Run \`bun web/scripts/vectors.ts\` and commit spec/vectors, or fix the change that moved these bytes." >&2
  exit 1
fi
printf 'TypeScript output matches the committed vectors (%d files)\n' "${#FILES[@]}"

printf '\n==> Rust vectors\n'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/rust" "$TMP/norm"
cargo run -q --locked -p aparte-format --example vectors -- "$TMP/rust"

failed=0
for file in "${FILES[@]}"; do
  if [ ! -f "$TMP/rust/$file" ]; then
    printf '\ncheck-vectors: the Rust generator did not write %s\n' "$file" >&2
    failed=1
    continue
  fi
  if ! jq -S . "$TMP/rust/$file" >"$TMP/norm/rust-$file" 2>"$TMP/norm/error"; then
    printf '\ncheck-vectors: the Rust %s is not JSON: %s\n' "$file" "$(cat "$TMP/norm/error")" >&2
    failed=1
    continue
  fi
  jq -S . "$VECTORS/$file" >"$TMP/norm/ts-$file"
  if ! diff -u --label "typescript/$file" --label "rust/$file" "$TMP/norm/ts-$file" "$TMP/norm/rust-$file"; then
    printf '\ncheck-vectors: %s differs between TypeScript and Rust (diff above, jq -S normalised)\n' "$file" >&2
    failed=1
  fi
done

while IFS= read -r extra; do
  name="$(basename "$extra")"
  if [ ! -f "$VECTORS/$name" ]; then
    printf '\ncheck-vectors: the Rust generator wrote %s, which the TypeScript reference does not\n' "$name" >&2
    failed=1
  fi
done < <(find "$TMP/rust" -maxdepth 1 -type f)

if [ "$failed" -ne 0 ]; then
  printf '\ncheck-vectors: FAILED: TypeScript and Rust disagree\n' >&2
  exit 1
fi
printf 'Rust output matches the TypeScript vectors (%d files)\n' "${#FILES[@]}"

printf '\n==> Frozen fixtures\n'
FIXTURES=spec/fixtures
untracked="$(git ls-files --others --exclude-standard -- "$FIXTURES")"
if [ -n "$untracked" ]; then
  printf '\ncheck-vectors: fixtures are not committed:\n%s\n' "$untracked" >&2
  exit 1
fi
if ! git diff --exit-code --stat -- "$FIXTURES"; then
  printf '\ncheck-vectors: a committed fixture was changed (diff above). Fixtures are frozen: write a new one.\n' >&2
  exit 1
fi
(cd web && bun test src/core/sync/fixtures.test.ts)
cargo test -q --locked -p aparte-format --test fixtures
cargo test -q --locked -p aparte-sync --test fixture
printf 'Both implementations read the fixtures\n'

printf '\n==> Mixed sync, reference and CLI\n'
scripts/check-interop.sh
printf '\ncheck-vectors: all vectors agree, the fixtures read back, and both implementations sync one vault\n'
