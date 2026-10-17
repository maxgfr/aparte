#!/usr/bin/env bash
# The Rust and repository gate: formatting, lints, tests, supply chain, workflow and shell lints.
# Stops at the first failing stage and names it. CI runs this script as is.
# A missing optional tool (cargo-deny, actionlint, shellcheck) skips its stage with a warning locally,
# and fails the run when CI=true, so CI can never pass a stage it did not run.
# Usage: scripts/check.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ "$#" -ne 0 ]; then
  echo "usage: scripts/check.sh" >&2
  exit 2
fi

SUMMARY=()
SKIPPED=()

stage() {
  local name="$1"
  shift
  printf '\n==> %s\n' "$name"
  local start=$SECONDS
  if ! "$@"; then
    printf '\ncheck: FAILED at stage "%s"\n' "$name" >&2
    exit 1
  fi
  SUMMARY+=("$(printf '%-12s %4ds' "$name" $((SECONDS - start)))")
}

# Returns 0 when the tool is on PATH. Otherwise warns and returns 1 locally, or fails the run in CI.
have_tool() {
  local tool="$1" hint="$2"
  if command -v "$tool" >/dev/null 2>&1; then
    return 0
  fi
  if [ "${CI:-}" = "true" ]; then
    printf '\ncheck: %s is required in CI but not installed; %s\n' "$tool" "$hint" >&2
    exit 1
  fi
  printf '\n!!! check: %s is not installed, SKIPPING this stage; %s\n' "$tool" "$hint" >&2
  SKIPPED+=("$tool")
  return 1
}

supply_chain() {
  have_tool cargo-deny "install it with \`brew install cargo-deny\` or \`cargo install --locked cargo-deny\`" ||
    return 0
  cargo deny --locked check
}

lint_workflows() {
  have_tool actionlint "install it with \`brew install actionlint\`" || return 0
  actionlint
}

lint_scripts() {
  have_tool shellcheck "install it with \`brew install shellcheck\` or \`apt-get install shellcheck\`" || return 0
  shellcheck scripts/*.sh
}

stage fmt cargo fmt --all --check
stage clippy cargo clippy --workspace --all-targets --locked -- -D warnings
stage test cargo test --workspace --locked
stage deny supply_chain
stage actionlint lint_workflows
stage shellcheck lint_scripts

printf '\ncheck: all stages passed\n'
printf '  %s\n' "${SUMMARY[@]}"
printf '  %-12s %4ds\n' total "$SECONDS"
if [ "${#SKIPPED[@]}" -ne 0 ]; then
  printf '\n!!! check: skipped because not installed: %s\n' "${SKIPPED[*]}" >&2
fi
