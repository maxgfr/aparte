#!/usr/bin/env bash
# The mixed end-to-end gate of sync: the TypeScript reference (web/src/core, the web app's code) and the Rust CLI
# (crates/aparte-sync) sync one vault through a local bare Git repository laid out as the web app's GitHub store
# (spec/FORMAT.md section 10.5: base64 files under aparte/).
# 1. The reference writes a store (web/scripts/fixtures.ts into a new directory); the CLI pushes its objects to the
#    repository, joins the vault from it as a new device, reads the conversation and the photo, answers, and pushes.
# 2. The reference reads a checkout of the repository as a new device: it sees the CLI's messages, with their
#    provider metadata, and raises no alarm. It answers in turn; the CLI pushes that and reads it back.
# 3. The CLI creates a vault of its own with a conversation and a photo; the reference joins it and reads them.
# Nothing under web/ or spec/ is written. Usage: scripts/check-interop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for tool in bun cargo jq git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "check-interop: $tool is required but not installed" >&2
    exit 1
  fi
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cargo build -q --locked -p aparte-sync --example interop
CLI="$ROOT/target/debug/examples/interop"
TS="$ROOT/scripts/interop/ts-device.ts"

expect() {
  # expect <file> <jq filter> <description>: the filter must give true.
  if [ "$(jq -r "$2" "$1")" != "true" ]; then
    printf '\ncheck-interop: FAILED: %s\n' "$3" >&2
    jq . "$1" >&2
    exit 1
  fi
  printf '  ok  %s\n' "$3"
}

printf '==> The reference writes a vault, the CLI reads and answers it over Git\n'
git init --bare -q -b main "$TMP/remote.git"
(cd web && bun scripts/fixtures.ts "$TMP/ts" >/dev/null)
PASS="$(jq -r .passphrase "$TMP/ts/fixture.json")"
KIT="$(jq -r .secretKey "$TMP/ts/fixture.json")"
PHOTO_SHA="$(jq -r .photo.sha256 "$TMP/ts/fixture.json")"
"$CLI" push-folder "$TMP/remote.git" "$TMP/ts/store" >"$TMP/push.json"
expect "$TMP/push.json" '.pushed == 19' 'the reference store is on the repository'
"$CLI" read "$TMP/remote.git" "$TMP/cli" "$PASS" "$KIT" >"$TMP/cli-read.json"
expect "$TMP/cli-read.json" '.alarms == []' 'the CLI raises no alarm'
expect "$TMP/cli-read.json" '.conversations[0].title == "Renamed on the second device"' 'the CLI reads the title'
expect "$TMP/cli-read.json" '[.conversations[0].path[].role] == ["user","assistant","user","user"]' 'the CLI reads the branch'
expect "$TMP/cli-read.json" ".conversations[0].path[2].parts[0].sha256 == \"$PHOTO_SHA\"" 'the CLI reassembles the photo'
expect "$TMP/cli-read.json" '.conversations[0].path[1].parts[0].providerMeta.anthropic.signature == "c2ln"' 'the CLI keeps the provider metadata'
"$CLI" append "$TMP/remote.git" "$TMP/cli" "$PASS" "$KIT" "Written by the CLI" >"$TMP/cli-append.json"
expect "$TMP/cli-append.json" '.alarms == [] and (.conversations[0].path | length) == 6' 'the CLI answers and pushes'

printf '\n==> The reference reads what the CLI wrote, and answers\n'
git clone -q "$TMP/remote.git" "$TMP/checkout"
bun "$TS" read "$TMP/checkout" "$PASS" "$KIT" >"$TMP/ts-read.json"
expect "$TMP/ts-read.json" '.alarms == []' 'the reference raises no alarm'
expect "$TMP/ts-read.json" '.conversations[0].title == "Answered in the CLI"' 'the reference reads the CLI title'
expect "$TMP/ts-read.json" '[.conversations[0].path[].role] == ["user","assistant","user","user","user","assistant"]' 'the reference reads the CLI branch'
expect "$TMP/ts-read.json" '.conversations[0].path[4].parts[0].text == "Written by the CLI"' 'the reference reads the CLI message'
expect "$TMP/ts-read.json" '.conversations[0].path[5].parts[0].providerMeta.anthropic.data == "cmVkYWN0ZWQ"' 'the CLI provider metadata survives'
expect "$TMP/ts-read.json" ".conversations[0].path[2].parts[0].sha256 == \"$PHOTO_SHA\"" 'the reference still reads the photo'
bun "$TS" write "$TMP/checkout" "$PASS" "$KIT" "Written by the reference" "$TMP/ts-out" >"$TMP/ts-write.json"
expect "$TMP/ts-write.json" '.alarms == [] and (.conversations[0].path | length) == 7' 'the reference answers'
"$CLI" push-folder "$TMP/remote.git" "$TMP/ts-out" >/dev/null
"$CLI" read "$TMP/remote.git" "$TMP/cli" "$PASS" "$KIT" >"$TMP/cli-read2.json"
expect "$TMP/cli-read2.json" '.alarms == []' 'the CLI raises no alarm on the second round'
expect "$TMP/cli-read2.json" '.conversations[0].path[-1].parts[0].text == "Written by the reference"' 'the CLI reads the reference answer'

printf '\n==> The CLI creates a vault, the reference joins it\n'
git init --bare -q -b main "$TMP/cli-remote.git"
"$CLI" create "$TMP/cli-remote.git" "$TMP/cli-born" >"$TMP/created.json"
CPASS="$(jq -r .passphrase "$TMP/created.json")"
CKIT="$(jq -r .secretKey "$TMP/created.json")"
CSHA="$(jq -r .photo.sha256 "$TMP/created.json")"
git clone -q "$TMP/cli-remote.git" "$TMP/cli-checkout"
bun "$TS" read "$TMP/cli-checkout" "$CPASS" "$CKIT" >"$TMP/ts-cli.json"
expect "$TMP/ts-cli.json" '.alarms == []' 'the reference raises no alarm'
expect "$TMP/ts-cli.json" '.conversations[0].title == "Started in the CLI" and .conversations[0].system == "Answer briefly."' 'the reference reads the CLI conversation'
expect "$TMP/ts-cli.json" '[.conversations[0].path[].role] == ["user","assistant"]' 'the reference reads the CLI branch'
expect "$TMP/ts-cli.json" ".conversations[0].path[0].parts[1].sha256 == \"$CSHA\" and .conversations[0].path[0].parts[1].bytes == 2101248" 'the reference reassembles the CLI photo'
expect "$TMP/ts-cli.json" '.conversations[0].path[1].parts[0].providerMeta.anthropic.signature == "Y2xp"' 'the reference reads the CLI reasoning metadata'
expect "$TMP/ts-cli.json" '.conversations[0].path[1].usage.input == 10 and .conversations[0].path[1].stop == "end"' 'the reference reads the CLI usage and stop'

printf '\ncheck-interop: the CLI and the reference sync one vault both ways\n'
