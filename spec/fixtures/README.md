# fixtures

Stores written by the TypeScript reference and read back by both implementations. A fixture is frozen with the
format version it was written in: it is never regenerated, edited or deleted, and a new one goes into a new
directory (`web/scripts/fixtures.ts` refuses to write into one that exists).

## sync-v1

An `aparte/1` store as two devices of one vault left it after syncing through it:

- device A created the vault (a passphrase slot with a Secret Key, a recovery slot), wrote a folder, a provider entry,
  a setting, and one conversation: a user message in several scripts, an answer with a reasoning part and its
  provider metadata, a photo of 2 MiB + 4 KiB (two chunks and a manifest);
- device B joined from the store, renamed the conversation and added a message; A read that and wrote again;
- the documents `index` and one conversation shard have checkpoints (written every 3 segments for the fixture) and
  segments whose `seen` name the other device.

| Path | Content |
|---|---|
| `store/` | every object byte for byte under its name (the layout of a folder store, FORMAT.md section 10.5) |
| `fixture.json` | `passphrase`, `secretKey` (Emergency Kit text), `recoveryKey`, `vault`, the device tags, the document tags, the photo's blob id, size and SHA-256, every object with its SHA-256 and what it decodes to (stream headers and the SHA-256 of their updates, chunk sizes and plaintext hashes, manifests), and each document's maps as JSON |

The vault protects nothing: its randomness is seeded, its Argon2 parameters are the small ones of
`spec/vectors/inputs.json`, and its secrets are in `fixture.json`.

Readers: `web/src/core/sync/fixtures.test.ts` (opens everything, rebuilds the documents, joins the vault as a new
device and syncs it) and `crates/aparte-format/tests/fixtures.rs` (opens both keyslots and every object, checks every
header, chunk id, manifest and the photo; Yjs updates are compared by hash). `scripts/check-vectors.sh` runs both and
fails when a fixture is uncommitted or changed.
