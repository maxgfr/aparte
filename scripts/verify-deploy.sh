#!/usr/bin/env bash
# Checks that a deployed copy of the web app is exactly a build of this repository.
#
#   scripts/verify-deploy.sh [--site URL] [--repo OWNER/NAME] [--no-attestation] [--rebuild COMMIT --version X.Y.Z]
#
# 1. Downloads the live index.html and sw.js, then every file the service worker precaches, and checks each one
#    against the SRI digest compiled into sw.js (what the worker itself enforces before serving it).
# 2. Unless --no-attestation: verifies sw.js with `gh attestation verify` against the build provenance the deploy
#    workflow publishes (.github/workflows/deploy.yml, signed by that workflow in --repo), reads from that attestation
#    the SHA-256 of every file of the build, and checks every one of them as the site serves it (the sandbox pages, the
#    OAuth callback and the lazy chunks the worker does not precache included).
# 3. With --rebuild: builds COMMIT in a temporary worktree (`bun install --frozen-lockfile`, then the production build
#    for the site's origin and path, with the version and commit the About screen of the site shows) and compares
#    every file of that build with the live copy, byte for byte. Run it on Linux x86-64 with CI's Bun version: the PWA
#    icons generated at build time differ on other platforms, and so does sw.js, which carries their digests.
#
# Exit status: 0 when every check passed, 1 when a file differs or an attestation does not verify, 2 on a usage or
# tooling error. Needs curl, jq and openssl; gh for the attestation; git and bun for --rebuild.
set -euo pipefail

site="https://maxgfr.github.io/aparte/"
repo="maxgfr/aparte"
attest=1
rebuild=""
version=""

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --site) site="${2:?--site needs a URL}"; shift 2 ;;
    --repo) repo="${2:?--repo needs OWNER/NAME}"; shift 2 ;;
    --no-attestation) attest=0; shift ;;
    --rebuild) rebuild="${2:?--rebuild needs a commit}"; shift 2 ;;
    --version) version="${2:?--version needs X.Y.Z}"; shift 2 ;;
    -h | --help) usage ;;
    *) echo "verify-deploy: unknown argument $1" >&2; usage ;;
  esac
done

case "$site" in
  https://*/ | http://localhost:*/ | http://127.0.0.1:*/) ;;
  *) echo "verify-deploy: --site must be an https URL (or the loopback) ending in /" >&2; exit 2 ;;
esac
if [ -n "$rebuild" ] && [ -z "$version" ]; then
  echo "verify-deploy: --rebuild needs --version (the version the site's About screen shows)" >&2
  exit 2
fi

need() {
  command -v "$1" > /dev/null || { echo "verify-deploy: $1 is required" >&2; exit 2; }
}
need curl
need jq
need openssl
if [ "$attest" = 1 ]; then need gh; fi
if [ -n "$rebuild" ]; then
  need git
  need bun
fi

work="$(mktemp -d)"
cleanup() {
  if [ -n "$rebuild" ] && [ -d "$work/src" ]; then git worktree remove --force "$work/src" > /dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

live="$work/live"
mkdir -p "$live"
# The Pages CDN caches for minutes: a unique query asks the origin for a fresh copy of every file.
nonce="verify-$(date +%s)-$$"
failures=0

fail() {
  echo "MISMATCH $*"
  failures=$((failures + 1))
}

# Downloads the published path $1 into the live directory; prints nothing, fails the run on an HTTP error.
fetch() {
  local path="$1"
  mkdir -p "$(dirname "$live/$path")"
  if ! curl -fsSL --proto '=https,http' -o "$live/$path" "${site}${path}?${nonce}"; then
    fail "$path: the site did not serve it"
    return 1
  fi
}

sha256_hex() { openssl dgst -sha256 -r "$1" | cut -d' ' -f1; }
sha256_sri() { printf 'sha256-%s' "$(openssl dgst -sha256 -binary "$1" | openssl base64 -A)"; }

echo "Site: $site"
fetch index.html || true
fetch sw.js || { echo "verify-deploy: no service worker at ${site}sw.js" >&2; exit 1; }

# 1. The precache manifest compiled into sw.js: {"integrity":"sha256-...","revision":...,"url":"..."} entries.
{ grep -o '{[^{}]*"integrity":"sha256-[^"]*"[^{}]*}' "$live/sw.js" || true; } | jq -s -c '.[] | {url, integrity}' \
  > "$work/precache.jsonl"
precached=$(wc -l < "$work/precache.jsonl" | tr -d ' ')
[ "$precached" -gt 0 ] || { echo "verify-deploy: sw.js carries no precache manifest" >&2; exit 1; }
grep -q '"url":"index.html"' "$work/precache.jsonl" || fail "index.html is not in the precache manifest"
while IFS=$'\t' read -r url integrity; do
  [ -f "$live/$url" ] || fetch "$url" || continue
  got="$(sha256_sri "$live/$url")"
  [ "$got" = "$integrity" ] || fail "$url: served $got, sw.js pins $integrity"
done < <(jq -r '[.url, .integrity] | @tsv' "$work/precache.jsonl")
echo "Precache: $precached files checked against the digests in sw.js"

# 2. The build provenance attestation of the deploy workflow.
if [ "$attest" = 1 ]; then
  if gh attestation verify "$live/sw.js" --repo "$repo" \
    --signer-workflow "$repo/.github/workflows/deploy.yml" --format json > "$work/attestation.json" 2> "$work/attestation.err"; then
    jq -r '.[0].verificationResult.statement.subject[] | "\(.digest.sha256)\t\(.name)"' "$work/attestation.json" \
      > "$work/subjects.tsv"
    commit=$(jq -r '.[0].verificationResult.signature.certificate.sourceRepositoryDigest // "unknown"' "$work/attestation.json")
    subjects=$(wc -l < "$work/subjects.tsv" | tr -d ' ')
    echo "Attestation: sw.js verified, signed by $repo/.github/workflows/deploy.yml at commit $commit ($subjects files)"
    while IFS=$'\t' read -r digest name; do
      [ -f "$live/$name" ] || fetch "$name" || continue
      got="$(sha256_hex "$live/$name")"
      [ "$got" = "$digest" ] || fail "$name: served sha256:$got, the attestation names sha256:$digest"
    done < "$work/subjects.tsv"
    for path in index.html sw.js; do
      grep -q "	$path\$" "$work/subjects.tsv" || fail "$path is not named by the attestation"
    done
    echo "Attestation: $subjects files checked as the site serves them"
  else
    sed 's/^/  /' "$work/attestation.err" >&2
    fail "sw.js: no build provenance attestation of $repo verifies it"
  fi
fi

# 3. A local build of the same commit, compared byte for byte.
if [ -n "$rebuild" ]; then
  root="$(git rev-parse --show-toplevel)"
  sha="$(git -C "$root" rev-parse --verify "$rebuild^{commit}")"
  origin="$(printf '%s' "$site" | sed -E 's#^(https?://[^/]+).*#\1#')"
  base="$(printf '%s' "$site" | sed -E 's#^https?://[^/]+##')"
  echo "Rebuild: $sha as version $version for origin $origin, path $base"
  git -C "$root" worktree add --detach "$work/src" "$sha" > /dev/null 2>&1
  (
    cd "$work/src/web"
    bun install --frozen-lockfile > "$work/install.log" 2>&1
    VITE_ORIGIN="$origin" VITE_BASE="$base" APP_VERSION="$version" GITHUB_SHA="$sha" bunx vite build \
      > "$work/build.log" 2>&1
  ) || {
    echo "verify-deploy: the rebuild failed:" >&2
    tail -n 20 "$work/install.log" "$work/build.log" >&2 2> /dev/null || true
    exit 2
  }
  built="$work/src/web/dist"
  count=0
  while IFS= read -r -d '' file; do
    path="${file#"$built"/}"
    count=$((count + 1))
    [ -f "$live/$path" ] || fetch "$path" || continue
    cmp -s "$file" "$live/$path" || fail "$path: the live copy differs from the rebuild"
  done < <(find "$built" -type f -print0)
  echo "Rebuild: $count files compared with the live copy"
fi

if [ "$failures" -gt 0 ]; then
  echo "verify-deploy: $failures check(s) failed" >&2
  exit 1
fi
echo "verify-deploy: every check passed"
