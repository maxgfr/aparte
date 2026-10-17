# aparte/1 vectors

`inputs.json` is the only hand-written file here. It fixes every input of the vectors: the master key, the vault and
device ids, the keyslot slot ids, salts and IVs, the passphrases (one non-ASCII, with an NFKC-equivalent twin), the
Secret Key and recovery key, the malicious keyslot mutations (as values and as text), the envelope names and
payloads, the tamper mutations, the Argon2id parameters
(`m = 19456`, `t = 2`, `p = 1`, the smallest the format accepts, so the vectors run fast). It holds no expected output.
The one exception in kind is `deflated`: compressed bytes are not reproducible across libraries, so a compressed
envelope case gives the exact deflate-raw stream to seal, and opening it must return `payload`.

The other files are generated, never edited:

| File | Content |
|---|---|
| `keys.json` | the six subkeys as raw bytes, `mkCheck`, `K_obj` for every envelope name, `K_local` for every local name |
| `keyslots.json` | for each keyslot: Argon2 output (passphrase kinds), `IKM`, `KEK`, `K_wrap`, `K_commit`, `commit`, `aad`, the file bytes; the Secret Key and recovery key text; for each malicious and text case, the file bytes and the error |
| `envelopes.json` | for each envelope: header, `aad`, plaintext, sealed bytes; for each tamper case, the bytes or name opened and the error |
| `names.json` | `dtag` of each device, `stag` of each `docId`, the shard of each `convId`, segment and checkpoint names, chunk and manifest ids and names, `ktag` and secret version names, local record names |
| `padme.json` | `padme(L)` for each `L` of `padme`, and the envelope plaintext size `max(64, padme(4 + L))` |
| `framing.json` | the segment and checkpoint payload bytes (`u32be(hlen) || header || update`) and the local record payload of `framing` |
| `text.json` | base32 and base64url of each `text` sample, and the error for each invalid sample |

## How the implementations consume it

- **TypeScript** (the reference): `bun web/scripts/vectors.ts [out-dir]` reads `inputs.json` and writes every
  generated file into `out-dir` (default: this directory). Randomness comes from a queued RNG (`queueRng` in
  `web/src/core/crypto/rng.ts`) loaded with the case's values in the order FORMAT.md section 6.6 and section 7.6 define
  (`slotId`, `salt`, `iv` for a passphrase slot; `slotId`, `iv` for the others; the IV for an envelope). Raw subkey
  bytes are computed with `hkdfSha256` exactly as FORMAT.md section 5 states, since the vault itself only holds
  non-extractable keys.
- **Rust**: `cargo run -q -p aparte-format --example vectors -- [out-dir]` reads the same `inputs.json` (located from
  the crate, `../../spec/vectors/inputs.json`) and writes the same files into `out-dir` (default: this directory).
- **CI** runs `scripts/check-vectors.sh`: it regenerates the TypeScript files here and fails on
  `git diff --exit-code -- spec/vectors` (the committed vectors are the reference's current output), then runs the
  Rust example into a temporary directory and compares every file with the TypeScript one after `jq -S` (so member
  order and whitespace are not compared, every name and value is). The unit tests of each side also open every sealed
  vector and check every error.

Generated files are JSON with 2-space indentation and a final line feed, byte strings as lowercase hex, members in
the order of the schemas below. `JSON.stringify(value, null, 2)` and `serde_json::to_writer_pretty` both produce that
layout.

## Output schema

Conventions for every file:

- `hex` is a lowercase hex string of the bytes; `b32` is the strict lowercase base32 of FORMAT.md section 3.1.
- An error is the stable code of FORMAT.md section 12 (`"corrupt"`, `"tampered"`, `"unsupported-keyslot"`...),
  as the opening or parsing function of the reference throws it.
- A list of cases has one entry per input case, in `inputs.json` order. A case repeats the small inputs that
  identify it (`id`, `kind`, `name`, `seq`...) but not large byte inputs (payloads, chunks), which stay in
  `inputs.json` at the same index.
- A member marked *optional* is omitted, never `null`, when it does not apply.

### keys.json

```jsonc
{
  "mk": hex,                      // inputs.mk
  "vaultId": hex,                 // inputs.vaultId
  "vault": b32,                   // base32 of vaultId
  "subkeys": {                    // K_purpose = HKDF(MK, "aparte/1/vault" || vaultId, "aparte/1/" || purpose)
    "obj-enc": hex, "obj-name": hex, "blob-id": hex, "local-enc": hex, "local-name": hex, "check": hex
  },
  "mkCheck": hex,                 // HMAC(K_check, "aparte/1/check|" || vaultId)
  "objectKeys": [                 // every envelope of kind 1 to 5, in inputs.envelopes order
    { "name": string, "key": hex } // K_obj(name)
  ],
  "localKeys": [                  // every kind-6 envelope name, then every local record name of names.json "local"
    { "name": string, "key": hex } // K_local(name)
  ]
}
```

### keyslots.json

```jsonc
{
  "keyslots": [                   // inputs.keyslots, each created with the queued RNG of section 6.6
    {
      "id": string,
      "kind": "passphrase" | "recovery" | "passkey",
      "slotId": hex,
      "salt": hex,                // optional: passphrase only
      "iv": hex,
      "name": string,             // keys/<slotId b32>.json
      "argon2": hex,              // optional: passphrase only, A = Argon2id(UTF-8(NFKC(passphrase)), salt, m, t, p, 32)
      "ikm": hex,                 // A || SK, A, R or the PRF output
      "kek": hex,
      "kWrap": hex,
      "kCommit": hex,
      "commit": hex,
      "aad": hex,                 // UTF-8 of "aparte/1|keyslot|" || vault || "|" || slot || "|" || kind || "|" || canon(kdf)
      "wrapCt": hex,              // AES-GCM(K_wrap, iv, MK, aad), 48 bytes
      "mkCheck": hex,
      "file": hex                 // the keyslot file: writer serialization plus "\n"
    }
  ],
  "secretKeyText": string,        // formatSecretKey(inputs.secretKey), A1-XXXXX-...
  "recoveryKeyText": string,      // formatRecoveryKey(inputs.recoveryKey), 13 groups of 4
  "malicious": [                  // inputs.maliciousKeyslots.cases
    {
      "id": string,
      "file": hex,                // the mutated file, built as described below
      "error": string             // what parseKeyslot throws: "unsupported-keyslot" for every case
    }
  ],
  "texts": [                      // inputs.keyslotTexts.cases
    {
      "id": string,
      "file": hex,                // the base file's text with the first `find` replaced by `replace`
      "error": string             // what parseKeyslot throws: "corrupt" or "unsupported-keyslot" (FORMAT.md 3.5, 6.7)
    }
  ]
}
```

A malicious file is the base slot's file parsed as JSON, with the member at `path` replaced in place (keeping its
position), removed (`delete: true`, the other members keeping their order) or appended as the last member of its
object (when absent), then serialized without whitespace as `JSON.stringify` writes it (so `65536.5` stays
`65536.5` and `4294967296` stays an integer), followed by `"\n"`.

A text case edits the base slot's file as text instead: the first occurrence of `find` becomes `replace`. That is how
the vectors hold JSON no parsed value serializes back to: a number beyond binary64, nesting deeper than serde_json's
default limit, an escaped lone surrogate, a repeated member (FORMAT.md section 3.5).

### envelopes.json

```jsonc
{
  "envelopes": [                  // inputs.envelopes, each sealed with a queued RNG holding its iv
    {
      "id": string,
      "kind": 1..6,
      "compression": "none" | "precompressed",
      "name": string,
      "header": hex,              // the 20 header bytes
      "aad": hex,                 // header || vaultId || name
      "plaintext": hex,           // u32be(n) || payload' || zero padding, P = max(64, padme(4 + n)) bytes
      "sealed": hex,              // header || AES-GCM(key, iv, plaintext, aad)
      "payload": hex              // what openEnvelope returns: the inputs payload (inflated for precompressed)
    }
  ],
  "tamper": [                     // inputs.tamper.cases applied to the sealed base envelope
    {
      "id": string,
      "kind": 1..6,               // the expected kind passed to openEnvelope (the base's)
      "name": string,             // the name passed to openEnvelope
      "vaultId": hex,             // the vault whose subkeys open it (otherVaultId for vault-swap)
      "bytes": hex,               // the bytes passed to openEnvelope
      "error": string             // what openEnvelope throws
    }
  ]
}
```

The `raw` tamper cases are built as `header || AES-GCM(K_obj(base name), iv, plaintext, aad)` with
`header = 41505431 01 <base kind> <flags, default 00> 00 <iv>` and `aad = header || vaultId || base name`.

### names.json

```jsonc
{
  "devices": [ { "device": "a" | "b", "deviceId": hex, "dtag": string } ],   // inputs.deviceIds, a then b
  "docs": [ { "docId": string, "stag": string } ],                           // names.docIds
  "shards": [ { "convId": hex, "shard": "c00".."c15" } ],                    // names.convIds
  "segments": [ { "doc": string, "device": "a" | "b", "seq": number, "name": string } ],
  "checkpoints": [ { "doc": string, "device": "a" | "b", "seq": number, "name": string } ],
  "chunks": [ { "id": b32, "name": string } ],                               // names.chunks: bid and b/<h2>/<bid>
  "manifests": [ { "id": b32, "name": string } ],                            // names.manifests (UTF-8 of the string)
  "secrets": [ { "secretId": hex, "seq": number, "ktag": string, "name": string } ],
  "local": [ { "purpose": string, "id": string, "name": string } ]           // localName(purpose, id)
}
```

### padme.json

```jsonc
{
  "padme": [ { "length": number, "padme": number, "paddedSize": number } ]   // padme(L), max(64, padme(4 + L))
}
```

### framing.json

```jsonc
{
  "segment": {
    "header": hex,                // writer serialization of framing.segment.header, "seen" sorted by key, "blobs" sorted
    "payload": hex                // u32be(len(header)) || header || update
  },
  "checkpoint": {
    "header": hex,                // the segment members, then "covers" sorted by key
    "payload": hex
  },
  "local": {
    "purpose": string,
    "id": string,
    "name": string,               // localName(purpose, id)
    "payload": hex                // u8(len(purpose)) || purpose || u16be(len(id)) || id || value
  }
}
```

The writer sorts `seen`, `covers` (by key) and `blobs` bytewise, as FORMAT.md section 9.1 and 9.2 require; the inputs
list them out of order on purpose.

### text.json

```jsonc
{
  "base32": [ { "hex": hex, "text": string } ],                // text.base32
  "base32Invalid": [ { "text": string, "error": string } ],    // base32Decode error, "invalid-input"
  "base64url": [ { "hex": hex, "text": string } ],             // text.base64url
  "base64urlInvalid": [ { "text": string, "error": string } ]  // base64urlDecode error, "invalid-input"
}
```

Known answers for the primitives themselves are in [`../kat`](../kat): RFC 5869 (HKDF-SHA256), RFC 4231
(HMAC-SHA256), RFC 9106 and the Argon2 reference tests (Argon2id), Wycheproof (AES-256-GCM, 12-byte IV, 16-byte tag).
Each file records its source URL and retrieval date.
