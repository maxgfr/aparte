# aparte/1 vectors

`inputs.json` is the only hand-written file here. It fixes every input of the vectors: the master key, the vault and
device ids, the keyslot slot ids, salts and IVs, the passphrases (one non-ASCII, with an NFKC-equivalent twin), the
Secret Key and recovery key, the envelope names and payloads, the tamper mutations, the Argon2id parameters
(`m = 19456`, `t = 2`, `p = 1`, the smallest the format accepts, so the vectors run fast). It holds no expected output.
The one exception in kind is `deflated`: compressed bytes are not reproducible across libraries, so a compressed
envelope case gives the exact deflate-raw stream to seal, and opening it must return `payload`.

The other files are generated, never edited:

| File | Content |
|---|---|
| `keys.json` | the six subkeys as raw bytes, `mkCheck`, `K_obj` for every envelope name, `K_local` for every local name |
| `keyslots.json` | for each keyslot: Argon2 output (passphrase kinds), `IKM`, `KEK`, `K_wrap`, `K_commit`, `commit`, `aad`, the file bytes; the Secret Key and recovery key text; for each malicious case, the file bytes and the error |
| `envelopes.json` | for each envelope: header, `aad`, plaintext, sealed bytes; for each tamper case, the bytes or name opened and the error |
| `names.json` | `dtag` of each device, `stag` of each `docId`, the shard of each `convId`, segment and checkpoint names, chunk and manifest ids and names, `ktag` and secret version names, local record names |
| `padme.json` | `padme(L)` for each `L` of `padme`, and the envelope plaintext size `max(64, padme(4 + L))` |
| `framing.json` | the segment and checkpoint payload bytes (`u32be(hlen) || header || update`) and the local record payload of `framing` |
| `text.json` | base32 and base64url of each `text` sample, and the error for each invalid sample |

## How the implementations consume it

- **TypeScript** (the reference): `bun web/scripts/vectors.ts` reads `inputs.json` and writes every generated file.
  Randomness comes from a queued RNG (`queueRng` in `web/src/core/crypto/rng.ts`) loaded with the case's values in
  the order FORMAT.md section 6.6 and section 7.6 define (`slotId`, `salt`, `iv` for a passphrase slot; `slotId`, `iv`
  for the others; the IV for an envelope). Raw subkey bytes are computed with `hkdfSha256` exactly as FORMAT.md
  section 5 states, since the vault itself only holds non-extractable keys.
- **Rust**: `cargo run -p aparte-format --example vectors` reads the same `inputs.json` and writes the same files.
- **CI** runs both and fails on `git diff --exit-code -- spec/vectors`: the two implementations must produce identical
  bytes. The unit tests of each side also open every sealed vector and check every error.

Generated files are JSON with 2-space indentation and a final line feed, byte strings as lowercase hex, members in
the order of the table above and, within a case, the order of `inputs.json` followed by the outputs in the order
listed. `JSON.stringify(value, null, 2)` and `serde_json::to_writer_pretty` both produce that layout.

Known answers for the primitives themselves are in [`../kat`](../kat): RFC 5869 (HKDF-SHA256), RFC 4231
(HMAC-SHA256), RFC 9106 and the Argon2 reference tests (Argon2id), Wycheproof (AES-256-GCM, 12-byte IV, 16-byte tag).
Each file records its source URL and retrieval date.
