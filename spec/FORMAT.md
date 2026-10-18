# Format `aparte/1`

**Status: frozen.** This document is normative and frozen since milestone M3: a change to any byte layout, name, label
or rule below needs a new format version (`aparte/2`), new vectors and new fixtures, never edited ones. The vectors
([`vectors/`](vectors/README.md)) pin every primitive and encoding, and the fixture ([`fixtures/`](fixtures/README.md))
pins a whole store written by the reference, which both implementations read back (section 15.4).

`aparte/1` is how Aparté stores a vault: on the device (IndexedDB) and on the storage the user syncs to (a Git
repository, a bucket, a folder). The web app (TypeScript, `web/src/core/crypto`, the reference) and the CLI (Rust,
`crates/`) read and write the same bytes. [DATA-MODEL.md](DATA-MODEL.md) describes what the encrypted documents
contain; this document describes how they are keyed, named, framed and encrypted.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. A reader that meets anything this document does
not allow rejects the input with the error named in [section 12](#12-errors); it never guesses.

## Contents

1. [Conventions](#1-conventions)
2. [Primitives](#2-primitives)
3. [Encodings](#3-encodings)
4. [Identifiers](#4-identifiers)
5. [Key schedule](#5-key-schedule)
6. [Keyslots](#6-keyslots)
7. [Envelope](#7-envelope)
8. [Object names](#8-object-names)
9. [Payloads](#9-payloads)
10. [Store rules and anti-rollback](#10-store-rules-and-anti-rollback)
11. [Local storage](#11-local-storage)
12. [Errors](#12-errors)
13. [What leaks](#13-what-leaks)
14. [Known limits](#14-known-limits)
15. [Vectors and worked examples](#15-vectors-and-worked-examples)
16. [Share inbox](#16-share-inbox)

## 1. Conventions

- Integers are unsigned and big-endian unless stated. `u8`, `u16be`, `u32be` are 1, 2 and 4 bytes.
- `||` is byte concatenation. A quoted string inside a byte expression, such as `"dtag|"`, stands for its UTF-8
  bytes, without a terminator.
- `x[a..b]` is the slice of `x` from index `a` included to `b` excluded; for a string, the characters.
- Text is UTF-8. Every string this format stores or hashes MUST be well-formed Unicode (no lone surrogate): a writer
  refuses one (`invalid-input`) and a reader rejects one (`corrupt`).
- In this document byte values are written as lowercase hex.
- `seq10` is a decimal integer written with exactly 10 digits, zero-padded (`0000000042`); `bucket7` is one with
  exactly 7 digits.

## 2. Primitives

| Name | Definition | Web | Rust |
|---|---|---|---|
| `SHA-256(x)` | FIPS 180-4, 32 bytes | WebCrypto | `sha2` 0.11 |
| `HMAC(k, x)` | HMAC-SHA-256 (RFC 2104, RFC 4231), 32 bytes | WebCrypto | `hmac` 0.13 |
| `HKDF(ikm, salt, info)` | RFC 5869 with SHA-256, `Expand(Extract(salt, ikm), info, 32)`: always 32 bytes | WebCrypto | `hkdf` 0.13 |
| `AES-GCM(k, iv, p, aad)` | AES-256-GCM, 12-byte IV, 16-byte tag, output `ciphertext || tag` | WebCrypto | `aes-gcm` 0.11 |
| `Argon2id(P, S, m, t, p, 32)` | RFC 9106, version `0x13`, no secret, no associated data, 32-byte tag | `hash-wasm` 4.12 | `argon2` 0.6 |
| `deflate-raw` | RFC 1951 stream, no zlib or gzip wrapper | `CompressionStream('deflate-raw')` | `flate2` or `miniz_oxide` |
| `padme(L)` | Padmé padding length, [section 7.4](#74-plaintext-layout-and-padding) | — | — |
| `NFKC(s)` | Unicode Normalization Form KC | `String.prototype.normalize('NFKC')` | `unicode-normalization` |

`HKDF` here always outputs 32 bytes. WebCrypto `deriveBits({name: 'HKDF', hash: 'SHA-256', salt, info}, ikm, 256)` and
Rust `Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, &mut [0u8; 32])` compute the same value. An empty `salt` is
the byte string of length zero (RFC 5869 then uses 32 zero bytes); this format never uses an empty salt.

Every comparison of a secret-derived value (`commit`, `mkCheck`, a recomputed name) MUST run in constant time for
equal lengths.

## 3. Encodings

### 3.1 base32

RFC 4648 section 6 alphabet, lowercased: `abcdefghijklmnopqrstuvwxyz234567`. No padding. Bits are taken most
significant first, 5 per character; the last character carries the remaining bits in its high positions and zeros
below.

- An encoder of `n` bytes outputs `ceil(8n / 5)` characters.
- A strict decoder accepts only that alphabet in lowercase, rejects `=`, whitespace and any other character, rejects a
  length whose remainder modulo 8 is 1, 3 or 6, and rejects a last character whose unused low bits are not zero. Every
  byte string therefore has exactly one encoding.
- 16 bytes encode to 26 characters: 128 bits fill 25 characters and the top 3 bits of the 26th, whose low 2 bits
  are zero, so the 26th character of an id is one of `a e i m q u y 4` (values that are multiples of 4).
- A **truncated tag** `b32(x)[0..n]` is the first `n` characters of the encoding of all of `x` (here always a 32-byte
  HMAC). Truncation is of characters, not bytes: 16 characters carry 80 bits, 26 carry 130, 8 carry 40.

User-facing strings (the Secret Key and the recovery key, [6.8](#68-secret-key-text) and [6.9](#69-recovery-key-text))
are shown in uppercase and parsed case-insensitively; everything stored is lowercase.

### 3.2 base64url

RFC 4648 section 5 alphabet (`A-Z a-z 0-9 - _`), no padding. A strict decoder rejects `=`, `+`, `/`, whitespace and
any other character, rejects a length whose remainder modulo 4 is 1, and rejects a last character whose unused low
bits are not zero. Used for binary fields inside JSON.

### 3.3 Canonical JSON

`canon(v)` is RFC 8785 (JSON Canonicalization Scheme). In `aparte/1` it is applied only to keyslot `kdf` objects,
whose values are strings, booleans and integers in `[0, 2^53)`; for those, `canon` is: object members sorted by key
(UTF-16 code units, which for these ASCII keys is byte order), no whitespace, strings escaped as `JSON.stringify`
escapes them, integers in plain decimal.

### 3.4 Writer serialization

Every other JSON this format writes (keyslot files, segment headers, manifests, secret versions) is serialized with
members in the order this document lists them, no insignificant whitespace, strings escaped as `JSON.stringify`
escapes them, integers in plain decimal, absent optional members omitted (never `null`). That is the output of
`JSON.stringify` on an object built in that order, and of `serde_json::to_vec` on a struct declared in that order.

### 3.5 Reading JSON

A reader reads JSON (RFC 8259) as `JSON.parse` does, so that two readers reach the same verdict on the same bytes:

- No limit on nesting depth or on the magnitude of a number. Such a value is valid JSON, judged by the rule of the
  member that holds it: `1e400` (beyond binary64) is a number out of every bound, and an array nested 200 deep is a
  value of the wrong type, or an extra member. A reader built on a parser with such limits (serde_json stops at 128
  levels and refuses `1e400`) skips the values it does not need without building them.
- A repeated member name keeps its last value. No file of this format repeats one, so the canonical-form check that
  follows rejects the file.
- A `\u` escape of a surrogate (`d800` to `dfff`) that is not a high surrogate immediately followed by a `\u` escape of
  a low surrogate makes the text not well-formed Unicode ([section 1](#1-conventions)): `corrupt`, before any other
  check, wherever the escape is (a member name, a string, a member that a later repeat replaces). An escaped
  backslash followed by `ud800` (`"\\ud800"`) is not an escape of a surrogate.

## 4. Identifiers

| Id | Size | Text form | Scope |
|---|---|---|---|
| `vaultId` | 16 random bytes | base32, 26 chars | one per vault, never changes |
| `slotId` | 16 random bytes | base32, 26 chars | one per keyslot |
| `deviceId` | 16 random bytes | base32, 26 chars | one per installation; stored encrypted on the device, never sent in clear |
| entity ids (conversation, message, folder, secret...) | 16 random bytes | base32, 26 chars | inside the encrypted documents |
| `docId` | ASCII string | itself | `index`, `c00` to `c15` |

No identifier embeds a time (no ULID, no UUIDv7): names visible to the store would otherwise date every object.
Timestamps exist only inside ciphertext.

## 5. Key schedule

### 5.1 Master key

`MK` is 32 random bytes, generated once when the vault is created. It never leaves the device in clear: it exists
only wrapped in keyslots ([section 6](#6-keyslots)) and, transiently, in memory while a keyslot is opened or created.
Implementations SHOULD zero their copy of `MK` as soon as the subkeys are derived.

### 5.2 Subkeys

For each `purpose` in `obj-enc`, `obj-name`, `blob-id`, `local-enc`, `local-name`, `check`:

```
K_purpose = HKDF(ikm = MK, salt = "aparte/1/vault" || vaultId, info = "aparte/1/" || purpose)
```

| Subkey | Used as | Purpose |
|---|---|---|
| `K_obj-enc` | HKDF input key | derives one AES key per remote object name |
| `K_obj-name` | HMAC key | device, document and secret tags, shard choice, name suffixes |
| `K_blob-id` | HMAC key | content ids of blob chunks and manifests |
| `K_local-enc` | HKDF input key | derives one AES key per local record name |
| `K_local-name` | HMAC key | names of local records |
| `K_check` | HMAC key | `mkCheck` |

On the web the six subkeys are held as non-extractable `CryptoKey` objects (HMAC keys with `['sign']`, HKDF keys with
`['deriveBits', 'deriveKey']`). WebCrypto cannot derive an HKDF key with `deriveKey` (its length is undefined), so an
HKDF subkey is computed with `deriveBits` and imported with `extractable: false`; the raw bytes are then dropped.

### 5.3 Per-object and per-record keys

```
K_obj(name)   = HKDF(ikm = K_obj-enc,   salt = vaultId, info = "aparte/1/obj|"   || name)
K_local(name) = HKDF(ikm = K_local-enc, salt = vaultId, info = "aparte/1/local|" || name)
```

`name` is the object name of [section 8](#8-object-names) or the local record name of
[section 11.3](#113-local-record-names), as ASCII. A name is one or more printable ASCII characters (`21` to `7e`):
an implementation derives no key for any other name (empty, with a space or a control character, or not ASCII) and
refuses it (`invalid-input`). Each is an AES-256-GCM key. Because every name has its own key, no
key encrypts more than a handful of messages (an object is written once, plus retries; a local record once per
update), far from the 2^32 random-IV limit of AES-GCM.

### 5.4 Master key check

```
mkCheck = HMAC(K_check, "aparte/1/check|" || vaultId)
```

Every keyslot stores `mkCheck`. After unwrapping `MK`, a reader derives `K_check` from it and compares in constant
time; a mismatch means the slot does not hold this vault's key (`tampered`).

## 6. Keyslots

A keyslot wraps `MK` under a secret the user holds. A vault has one or more keyslots; any one opens it. Keyslots are
plaintext JSON, both on the remote and on the device.

### 6.1 File

Remote name: `keys/<slotId b32>.json`. Locally: the `meta` store, key `keyslot:<slotId b32>`
([section 11](#11-local-storage)). The bytes are the writer serialization ([3.4](#34-writer-serialization)) of the
object below, followed by one line feed (`0a`).

### 6.2 Schema

Members, in writer order:

| Member | Type | Rule |
|---|---|---|
| `format` | string | exactly `aparte/1` |
| `type` | string | exactly `keyslot` |
| `vault` | string | base32 of `vaultId` (26 chars, strict) |
| `slot` | string | base32 of `slotId` (26 chars, strict); equals the file name |
| `kind` | string | `passphrase`, `recovery` or `passkey` |
| `kdf` | object | per kind, [6.3](#63-kdf-objects-and-bounds) |
| `commit` | string | base64url of 32 bytes |
| `wrap` | object | `{"iv": base64url of 12 bytes, "ct": base64url of 48 bytes}`, members in that order |
| `mkCheck` | string | base64url of 32 bytes |

No other member is allowed at any level.

### 6.3 kdf objects and bounds

**passphrase**, members in writer order:

| Member | Type | Bounds |
|---|---|---|
| `alg` | string | exactly `argon2id` |
| `v` | integer | exactly `19` (`0x13`) |
| `m` | integer | memory in KiB, `19456 <= m <= 262144` |
| `t` | integer | passes, `2 <= t <= 10` |
| `p` | integer | lanes, `1 <= p <= 4` |
| `salt` | string | base64url of exactly 16 bytes |
| `secretKey` | boolean | whether the Secret Key is part of the input |

Writers use `m = 65536`, `t = 3`, `p = 1`: fixed, never calibrated to the device, so every device can open every
slot. The vectors and tests use `m = 19456`, `t = 2`, `p = 1`, which are in bounds.

**recovery**: `{"alg": "recovery"}`.

**passkey** (only in builds served from a dedicated origin), members in writer order:

| Member | Type | Bounds |
|---|---|---|
| `alg` | string | exactly `prf` |
| `credentialId` | string | base64url of 16 to 1023 bytes |
| `rpId` | string | 1 to 253 characters of `[a-z0-9.-]` |
| `prfSalt` | string | base64url of exactly 32 bytes (the WebAuthn PRF `eval.first` input) |

A number is an integer only if it has no fraction and no exponent part that makes it fractional; `65536.5`, `"65536"`
and `-1` are out of bounds. A reader checks every bound **before** running Argon2 or anything else costly, so a hostile
slot cannot make a device burn memory or time.

### 6.4 Input key material

- passphrase: `A = Argon2id(UTF-8(NFKC(passphrase)), salt, m, t, p, 32)`. `IKM = A || SK` when `secretKey` is true
  (`SK`, the 16-byte Secret Key, [6.8](#68-secret-key-text)), else `IKM = A`. The passphrase MUST be non-empty after
  normalization and well-formed Unicode (`invalid-input` otherwise).
- recovery: `IKM = R`, the 32-byte recovery key ([6.9](#69-recovery-key-text)).
- passkey: `IKM` is the 32-byte PRF output of the credential for `prfSalt`.

NFKC makes the same passphrase typed on different keyboards give the same bytes: `ﬁ` (U+FB01) becomes `fi`, `Ⅻ`
(U+216B) becomes `XII`, `＃` (U+FF03) becomes `#`, and `e` followed by U+0301 becomes `é`. Normalization of assigned
code points is stable across Unicode versions, so an older engine and a newer one agree on every passphrase made of
characters both know.

### 6.5 Slot keys, commitment and wrap

```
KEK      = HKDF(IKM, salt = vaultId || slotId, info = "aparte/1/kek|" || kind)
K_wrap   = HKDF(KEK, salt = vaultId, info = "aparte/1/wrap")
K_commit = HKDF(KEK, salt = vaultId, info = "aparte/1/commit")
commit   = HMAC(K_commit, "aparte/1/commit|" || vaultId || slotId)
aad      = "aparte/1|keyslot|" || vault || "|" || slot || "|" || kind || "|" || canon(kdf)
wrap.ct  = AES-GCM(K_wrap, wrap.iv, MK, aad)
```

`vault` and `slot` in `aad` are the base32 strings of the file. `kind` is the ASCII kind name.

AES-GCM is not key-committing: a crafted ciphertext can decrypt under two keys. `commit` binds the slot to one `KEK`,
and it is checked before the wrap is decrypted, so a wrong secret is reported as `wrong-secret` without touching
AES-GCM, and only the right secret can reach the wrap.

### 6.6 Creating a keyslot

1. Draw from the RNG, in this order: `slotId` (16 bytes); for a passphrase slot, `salt` (16 bytes); `wrap.iv`
   (12 bytes). A passkey slot takes `credentialId`, `rpId` and `prfSalt` from the WebAuthn ceremony, not the RNG.
2. Compute `IKM`, `KEK`, `K_wrap`, `K_commit`, `commit`, `aad`, `wrap.ct`, and `mkCheck` from `MK`.
3. Serialize ([6.1](#61-file)).

The RNG order matters only to reproduce the vectors with a queued RNG; production draws from the platform CSPRNG.

### 6.7 Opening a keyslot

A reader MUST perform these steps in order and stop at the first failure:

1. Parse the bytes as JSON ([3.5](#35-reading-json)). Not UTF-8, an escaped lone surrogate anywhere in the text, not
   JSON, not an object, a member outside `kdf` that is missing, extra or of the wrong type (a number beyond binary64 or
   a deep nesting there is of the wrong type), a base64url or base32 field outside `kdf` that does not decode strictly or has the wrong length,
   `type` other than `keyslot`, or `slot` that differs from the file name: `corrupt`.
2. `format` other than `aparte/1`, an unknown `kind`, or any rule of [6.3](#63-kdf-objects-and-bounds) broken
   (including a missing or extra `kdf` member, whatever its value, and an `alg` that does not match `kind`):
   `unsupported-keyslot`.
3. Serialize the parsed value again ([6.1](#61-file)); if the bytes differ from the input: `corrupt`. A file is
   valid only in its single canonical form, so two parsers can never disagree about what it says.
4. `vault` differs from the vault being opened: `corrupt`.
5. Compute `IKM` (Argon2 runs here, and only here). A secret of another kind than the slot's, or a passphrase slot
   with `secretKey: true` opened without a Secret Key: `invalid-input` (the caller asks for the right secret).
6. Derive `KEK`, `K_commit`; recompute `commit`; on mismatch: `wrong-secret`.
7. Derive `K_wrap`; decrypt `wrap.ct` with `aad`; on failure: `tampered`.
8. Derive the subkeys from `MK`; recompute `mkCheck`; on mismatch: `tampered`.

To unlock with a passphrase, a device tries each passphrase slot of the vault (each costs one Argon2 run) until one
passes step 6. To unlock with a recovery key, it tries each recovery slot.

### 6.8 Secret Key text

The Secret Key `SK` is 16 random bytes generated with the vault; it makes a stolen copy of the remote useless for
guessing the passphrase. It is shown once in an Emergency Kit as:

```
C   = SHA-256("aparte/1/secret-key|" || SK)[0..3]
s   = uppercase(b32(SK || C)[0..30])
SKT = "A1-" || s[0..5] || "-" || s[5..10] || "-" || s[10..15] || "-" || s[15..20] || "-" || s[20..25] || "-" || s[25..30]
```

`b32(SK || C)` is 31 characters; the first 30 carry the 128 bits of `SK` and the first 22 bits of `C`. Parsing:
remove every space and hyphen, require the remaining text to be `A1` (case-insensitive) followed by exactly 30
characters of the base32 alphabet (case-insensitive), decode those 150 bits, and compare the 22 checksum bits; any
failure is `invalid-input`. Case-insensitive means ASCII case only: the text is checked to be ASCII before any case
mapping, so a character such as U+212A KELVIN SIGN, which Unicode lowercases to `k`, is refused. A typo is detected with probability 1 - 2^-22.

### 6.9 Recovery key text

The recovery key `R` is 32 random bytes, shown once as the 52 characters of `uppercase(b32(R))` in 13 groups of 4
separated by hyphens. Parsing removes spaces and hyphens, requires what is left to be ASCII letters and digits, lowercases
(ASCII case only, as in [6.8](#68-secret-key-text)), and requires a strict base32 decode to exactly 32 bytes
(`invalid-input` otherwise). There is no checksum beyond the 4 zero bits of the last character: a typo
surfaces as `wrong-secret` at step 6.

### 6.10 Changing the passphrase and removing slots

Changing the passphrase opens a current slot (to recover `MK`), creates a new passphrase slot (new `slotId`, new
`salt`, same `SK`), persists it, and only then removes the old slot: locally at once, on the remote where the store
allows deletion. On an append-only store (Git history) the old slot stays readable forever; see
[section 14](#14-known-limits). A vault always keeps at least one slot that is not a recovery slot.

Recovery opens a recovery slot, creates a passphrase slot for the new passphrase, persists it, and then removes the
other passphrase slots in the same way: the forgotten (or compromised) passphrase stops opening the vault.

## 7. Envelope

Every object except `fmt/1` and `keys/*.json`, on the remote and on the device, is an envelope.

### 7.1 Header

20 bytes:

| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | 4 | magic | `41 50 54 31` (`APT1`) |
| 4 | 1 | version | `01` |
| 5 | 1 | kind | [7.2](#72-kinds-and-flags) |
| 6 | 1 | flags | [7.2](#72-kinds-and-flags) |
| 7 | 1 | epoch | `00` in `aparte/1` |
| 8 | 12 | iv | random, drawn from the RNG for every seal |

The envelope is `header || AES-GCM(key, iv, plaintext, aad)`, so its length is `20 + P + 16` where `P` is the
plaintext size.

### 7.2 Kinds and flags

| Kind | Object | Key | Compression allowed |
|---|---|---|---|
| `1` | segment | `K_obj(name)` | yes |
| `2` | checkpoint | `K_obj(name)` | yes |
| `3` | blob chunk | `K_obj(name)` | no |
| `4` | blob manifest | `K_obj(name)` | no |
| `5` | secret version | `K_obj(name)` | no |
| `6` | local record | `K_local(name)` | no |

Flags: bit 0 (`01`) means the payload is a deflate-raw stream; it MAY be set only for kinds 1 and 2. Bits 1 to 7 MUST
be zero. The epoch byte is reserved for key rotation in a later version and MUST be `00`.

### 7.3 Associated data

```
aad = header || vaultId || name
```

`header` is the 20 bytes above, `vaultId` the 16 raw bytes, `name` the object name or local record name as ASCII. Every
header byte, the vault and the name are authenticated: an object copied to another name or another vault, or with any
header byte changed, does not decrypt.

### 7.4 Plaintext layout and padding

```
payload' = payload                 when flags bit 0 is clear
payload' = deflate-raw(payload)    when flags bit 0 is set
n        = len(payload')
P        = max(64, padme(4 + n))
plaintext = u32be(n) || payload' || (P - 4 - n) zero bytes
```

`padme(L)` (Padmé, Nikitin et al., PETS 2019): if `L < 2`, return `L`; otherwise `E = floor(log2(L))`,
`S = floor(log2(E)) + 1`, `z = E - S`, `mask = 2^z - 1`, return `(L + mask) & ~mask`. Padmé rounds a length up to at
most about 12 % more, leaking `O(log log L)` bits of it instead of `O(log L)`. Examples: `padme(65) = 72`,
`padme(100) = 104`, `padme(1000) = 1024`, `padme(1025) = 1088`, `padme(2097156) = 2162688`; the full list for
`inputs.json` → `padme` is computed into `vectors/padme.json`.

Size limits: `n <= 2^26` (64 MiB) for every kind, and the inflated payload of a compressed object MUST also be at most
`2^26` bytes; a blob chunk payload is at most 2 097 152 bytes ([8.6](#86-blobs)).

### 7.5 Opening

A reader is given the bytes, the object name, the vault and the **expected kind** (known from the name). It MUST
check, in this order:

| Step | Check | Error |
|---|---|---|
| 1 | length at least 100 (`20 + 64 + 16`) | `corrupt` |
| 2 | magic is `APT1` | `corrupt` |
| 3 | version is `01` | `unsupported-format` |
| 4 | kind is 1 to 6 and equals the expected kind | `corrupt` |
| 5 | flags have no bit other than bit 0, and bit 0 only for kinds 1 and 2 | `corrupt` |
| 6 | epoch is `00` | `unsupported-format` |
| 7 | AES-GCM decryption with the key of the kind and `aad` succeeds | `tampered` |
| 8 | `n <= P - 4` | `corrupt` |
| 9 | `P == max(64, padme(4 + n))` | `corrupt` |
| 10 | every padding byte is `00` | `corrupt` |
| 11 | when compressed: the stream inflates completely, with no trailing data, to at most 2^26 bytes | `corrupt` |

Steps 8 to 11 run on authenticated data, so they catch writer bugs rather than attacks; they make the plaintext
canonical, which keeps both implementations byte-identical. Appending bytes to an envelope or truncating it changes the
tag position, so step 7 fails (`tampered`) unless the result is shorter than 100 bytes (`corrupt`).

### 7.6 Sealing

Draw the IV (12 bytes), build the header, build the plaintext ([7.4](#74-plaintext-layout-and-padding)), encrypt.
A writer SHOULD set the compression flag for a segment or checkpoint when `deflate-raw` makes it smaller. Compressed
output is not reproducible across libraries, so names never depend on it ([8.4](#84-segments)) and the vectors seal
fixed, precomputed streams.

## 8. Object names

All names are lowercase ASCII. A reader parses names strictly: a name that does not match one of the forms below
exactly (an uppercase letter, an extra directory, a name a sync client renamed such as `x 2`) is ignored, never read.

### 8.1 Format marker

`fmt/1`: the 9 bytes `aparte/1\n` (`61 70 61 72 74 65 2f 31 0a`), plaintext. A store whose `fmt/1` holds anything
else is not an `aparte/1` store (`unsupported-format`).

### 8.2 Keyslots

`keys/<slot>.json`, `<slot>` the 26-character base32 of a `slotId` (strict).

### 8.3 Tags and shards

```
dtag  = b32(HMAC(K_obj-name, "dtag|"   || deviceId))[0..16]
stag  = b32(HMAC(K_obj-name, "doc|"    || docId))[0..16]
ktag  = b32(HMAC(K_obj-name, "secret|" || secretId))[0..16]
shard = "c" || two decimal digits of (HMAC(K_obj-name, "shard|" || convId)[0] & 0x0f)
```

`deviceId`, `secretId` and `convId` are the 16 raw bytes; `docId` is ASCII. `shard` is one of `c00` to `c15`: a
conversation lives in the shard document named by `shard`.

### 8.4 Segments

```
d/<stag>/s/<dtag>/<bucket7>/<seq10>-<r8>
bucket7 = floor(seq / 1000), 7 digits
r8      = b32(HMAC(K_obj-name, "seg|" || stag || dtag || seq10 || SHA-256(payload)))[0..8]
```

`seq` runs from 1, contiguous per (document, device), up to 9 999 999 999. `stag`, `dtag` and `seq10` enter the HMAC
as their ASCII characters; `payload` is the **uncompressed** payload ([9.1](#91-segment)). The name depends only on
the content, never on the ciphertext (the AAD includes the name, so it could not), and a retry of the same payload
reuses the same name.

### 8.5 Checkpoints

```
d/<stag>/c/<dtag>/<seq10>-<r8>
r8 = b32(HMAC(K_obj-name, "ckpt|" || stag || dtag || seq10 || SHA-256(payload)))[0..8]
```

`seq` is the last own segment the checkpoint covers.

### 8.6 Blobs

A file is split into chunks of 2 097 152 bytes (2 MiB) of plaintext, the last one shorter; an empty file has no
chunk.

```
chunk     b/<h2>/<bid>   bid = b32(HMAC(K_blob-id, "chunk|"    || SHA-256(chunk)))[0..26]
manifest  m/<h2>/<mid>   mid = b32(HMAC(K_blob-id, "manifest|" || SHA-256(manifest bytes)))[0..26]
h2 = the first 2 characters of bid or mid
```

The ids are keyed hashes of the plaintext: equal content in one vault gets one name (deduplication), and nobody
without the vault keys can test whether a given file is stored.

### 8.7 Secret versions

```
k/<ktag>/<seq10>-<r8>
r8 = b32(HMAC(K_obj-name, "sec|" || ktag || seq10 || SHA-256(payload)))[0..8]
```

`seq` is one more than the highest `seq` the writer lists under `ktag`; two devices writing at once produce two names
that differ in `r8`, and the version with the greatest `hlc` wins ([9.5](#95-secret-version)).

### 8.8 Grammar

```
b32c    = "a"-"z" / "2"-"7"
fmt     = "fmt/1"
keyslot = "keys/" 26b32c ".json"            ; strict base32 of 16 bytes
segment = "d/" 16b32c "/s/" 16b32c "/" 7DIGIT "/" 10DIGIT "-" 8b32c
ckpt    = "d/" 16b32c "/c/" 16b32c "/" 10DIGIT "-" 8b32c
chunk   = "b/" 2b32c "/" 26b32c             ; the 2 characters repeat the first 2 of the id
manif   = "m/" 2b32c "/" 26b32c             ; idem
secret  = "k/" 16b32c "/" 10DIGIT "-" 8b32c
```

A segment name whose `bucket7` is not `floor(seq / 1000)`, any `seq` of 0, or a blob name whose `h2` does not repeat
its id, is invalid.

## 9. Payloads

### 9.1 Segment

```
payload = u32be(hlen) || header || update
```

`header` is `hlen` bytes of JSON, `1 <= hlen <= 65536`; `update` is one Yjs update in the v2 encoding, non-empty.
Header members, in writer order:

| Member | Type | Rule |
|---|---|---|
| `v` | integer | `1` |
| `doc` | string | the `docId` (`index`, `c00`...`c15`) |
| `device` | string | the writer's `dtag` |
| `seq` | integer | this segment's `seq` |
| `time` | integer | writer's clock, Unix milliseconds; informative only, never trusted for ordering |
| `seen` | object | `dtag -> highest contiguous seq applied`, for every **other** device with segments in this document the writer had applied; members sorted by key, bytewise |
| `blobs` | array | manifest ids (`mid`) the update references, sorted bytewise, no duplicate |

A reader checks that `stag` of `doc` equals the name's `stag`, `device` equals the name's `dtag`, and `seq` equals the
name's `seq`; any mismatch, an unknown member, or a wrong type is `corrupt`.

### 9.2 Checkpoint

Same framing. The header has the segment members followed by `covers`: an object `dtag -> seq`, sorted by key, listing
for every device (the writer included) the highest segment whose update the checkpoint contains, contiguously from 1.
`covers[device] == seq`. The update is the full state of the document as one v2 update.

### 9.3 Blob chunk

The raw chunk bytes; no framing.

### 9.4 Blob manifest

JSON, members in writer order: `v` (integer `1`), `type` (MIME type string), `size` (integer, total bytes), `sha256`
(base64url of the SHA-256 of the whole file), `chunks` (array of `bid`, in file order, `ceil(size / 2097152)` entries),
`name` (optional string, the file name). A reader verifies, after fetching, that each chunk's recomputed `bid`
matches, that the chunks add up to `size`, and that the file's SHA-256 matches; otherwise `corrupt`.

### 9.5 Secret version

JSON, members in writer order: `v` (integer `1`), `id` (base32 of the 16-byte `secretId`), `hlc` (string),
`deleted` (optional, `true`), `value` (optional object, present exactly when `deleted` is absent). The reader checks
that `ktag` of `id` equals the name's `ktag`. `hlc` is a hybrid logical clock:
`<13-digit Unix ms>.<4-digit counter>.<dtag>`, compared bytewise; the greatest wins, ties are impossible because the
`dtag` differs. The shape of `value` is defined in [DATA-MODEL.md](DATA-MODEL.md#6-secrets).

### 9.6 Local record

```
payload = u8(len(purpose)) || purpose || u16be(len(id)) || id || value
```

`purpose` matches `[a-z][a-z0-9-]{0,31}`; `id` is 0 to 1024 bytes of UTF-8; `value` is the record's bytes. A writer
refuses a purpose or id outside these rules, and no local record name is derived for one (`invalid-input`). A reader
rejects a payload whose lengths run past its end, whose purpose breaks the rule or whose `id` is not UTF-8 or above
1024 bytes (`corrupt`, although the envelope authenticated), then recomputes the record name from `purpose` and `id`
and rejects a mismatch (`corrupt`), comparing in constant time ([section 2](#2-primitives)).

## 10. Store rules and anti-rollback

### 10.1 Immutability

Objects are written once and never rewritten. The state of a document is the merge of every segment and checkpoint
present, which Yjs makes commutative and idempotent. `aparte/1` never deletes an object, except a keyslot being
replaced ([6.10](#610-changing-the-passphrase-and-removing-slots)).

### 10.2 Upload order

On a fresh store: `fmt/1`, then keyslots, both confirmed by a listing; then chunks; a manifest only once its chunks are
confirmed; a segment or checkpoint only once every manifest it lists in `blobs` is confirmed. A device persists a
sealed segment locally before uploading it and retries with the same bytes, so a crash never produces two payloads for
one `seq`.

### 10.3 High-water marks

Each device keeps, encrypted ([11.3](#113-local-record-names), purpose `hwm`), per `(stag, dtag)` the highest `seq`
such that it has applied every segment `1..seq`, and the same for its own segments. It raises the alarm "the sync store
is withholding or rolled back data" when, in a complete listing:

- the highest listed `seq` of a known `(stag, dtag)` is below its high-water mark (rollback, force-push);
- a gap below a listed segment persists across two complete listings at least 10 minutes apart (withholding);
- a segment's `seen` or a checkpoint's `covers` names a `(dtag, seq)` that the store does not return under the same
  persistence rule (a device saw data this one is not given);
- two different segment names exist for one `(stag, dtag, seq)` (fork: a cloned device or an attack). A device that
  finds a segment or checkpoint under its own `dtag` that it did not write takes a new `deviceId`.

A device writes at most one checkpoint per own `seq`, so two checkpoint names for one `(stag, dtag, seq)` are a fork
as well. The marks a device keeps per destination (the highest `seq` listed per `(stag, dtag)`, its own segments
counted once uploaded) are compared with that destination's next listings; a destination that only carries a one-off
copy (an exported archive) keeps no marks.

The alarm stops nothing that is already local: data is never deleted because the store stopped returning it.

### 10.4 Trust on first use

A device that joins a vault has no high-water mark yet: it trusts the first state it lists. A store that withholds
data from a new device's first listing is not detected by that device, only by devices that saw the data before.

A device joins from the store's plaintext only: `fmt/1` and the keyslots. It holds the vault locked until the
passphrase and the Secret Key of the Emergency Kit open a slot; then it downloads everything else. For a document it
holds nothing of, it may start from the checkpoints and then fetch only the segments above their `covers` (applying
every checkpoint it holds covers, per device, the highest `covers` among them).

### 10.5 Store layouts

Every store holds the objects of section 8 under their names, relative to the store's root; anything else there (a
README, a file a sync client renamed) is not a name and is ignored.

| Store | Root | An object is |
|---|---|---|
| Git repository written through the GitHub API | the folder `aparte` of the branch (configurable) | a file whose content is the standard base64 (RFC 4648 section 4, padded, no line break) of the object's bytes: Git trees take inline content as UTF-8 text only |
| S3-compatible bucket | `<bucket>/<prefix>` | the object's bytes |
| folder | the chosen folder | the object's bytes, in sub-folders following the `/` of the name |
| archive (`.aparte.zip`) | the archive | a stored (uncompressed) zip entry named after the object, UTF-8 name, timestamp 1980-01-01; a reader also accepts deflated entries and checks each CRC-32 |

Git commits written by a device carry a constant message (`aparte: objects`) and a constant author, so the history
dates writes but neither names nor describes them. The first commit of an empty repository adds `aparte/README.md`.
A store's credentials (a token, S3 keys) are local records of purpose `sync-credential`: never in the store, never
in a synced document.

## 11. Local storage

### 11.1 Database

IndexedDB database `aparte-v1`, schema version 1, four object stores, all with out-of-line string keys:

| Store | Key | Value | Plaintext? |
|---|---|---|---|
| `meta` | fixed names, [11.2](#112-meta-entries) | string, bytes or `CryptoKey` | yes: no secret, no content |
| `objects` | remote object name | envelope bytes (kinds 1 to 5), exactly as on the remote | ciphertext |
| `local` | local record name | envelope bytes, kind 6 | ciphertext |
| `pending` | local record name (purpose `pending`) | envelope bytes, kind 6: local updates not yet sealed into a segment | ciphertext |

`objects` refuses a value shorter than 100 bytes or that does not start with an `aparte/1` header of kind 1 to 5, so
plaintext cannot land there by mistake. No key and no value anywhere carries a ULID, a timestamp or a readable
purpose.

### 11.2 meta entries

| Key | Value |
|---|---|
| `fmt` | string `aparte/1\n` |
| `vault` | string, base32 `vaultId` |
| `keyslot:<slot>` | string, the keyslot file ([6.1](#61-file)) |
| `device-key` | non-extractable AES-256-GCM `CryptoKey` (`['encrypt', 'decrypt']`), generated on this device |
| `secret-key` | bytes: `iv (12) || AES-GCM(device-key, iv, SK, "aparte/1|device-secret-key|" || vault)`, 44 bytes |

The Secret Key must be available before unlocking, so it cannot be a local record. When the user lets the device
remember it (the default), it is stored wrapped by `device-key`: a same-origin script can use that key but not export
it, and the stored bytes are not the Secret Key. A copy of the browser profile holds both, so the Secret Key protects
the remote, not a stolen device ([section 14](#14-known-limits)). Without `secret-key`, unlocking asks for the
Emergency Kit. A `secret-key` that does not unwrap under `device-key` counts as none: unlocking asks for the
Emergency Kit (and a Secret Key typed in then replaces both entries), and recovery pairs the new passphrase with a new
Secret Key under a new `device-key`. Non-sensitive UI preferences live in `localStorage` (`web/src/app/prefs.ts`),
never in `meta`.

Several pages of one origin (tabs, the installed app) share the database. A vault is created in one readwrite
transaction on `meta` that first reads `vault`: when it is set, nothing is written and the creation is refused, so a
page that loaded before the vault existed cannot replace it. Otherwise the transaction removes every entry (leftovers
of an interrupted creation) and writes `fmt`, the keyslots, `device-key`, `secret-key` and `vault`. Unlocking and
every slot change read the keyslots from `meta` again, so a slot another page added or removed is seen at once.

### 11.3 Local record names

```
localName = b32(HMAC(K_local-name, purpose || "|" || id))[0..26]
```

Purposes in `aparte/1`: `device` (`id` = `id`: the `deviceId`), `sync-credential`, `oauth-token`, `provider-key`
(an API key kept on this device only), `hwm` (high-water marks), `draft` (unsent input), and `pending`
(`id` = `<docId>|<n>`, `n` the decimal queue position). Listing the records of one purpose decrypts the store and
filters on the framed `purpose` ([9.6](#96-local-record)): no plaintext index exists.

## 12. Errors

| Code | Meaning |
|---|---|
| `wrong-secret` | the passphrase, Secret Key, recovery key or passkey does not open the slot (commit mismatch) |
| `unsupported-keyslot` | a keyslot this build will not run: unknown format, kind or algorithm, or a parameter out of bounds |
| `unsupported-format` | an envelope or store of another format version or key epoch |
| `corrupt` | malformed: bad JSON, bad encoding, bad length, bad padding, a name or header that does not match |
| `tampered` | authentication failed: AES-GCM tag, or `mkCheck` after a successful unwrap |
| `locked` | the operation needs the vault's keys and the vault is locked |
| `invalid-input` | a caller or user input is malformed (empty passphrase, Secret Key with a bad checksum, bad base32) |
| `invalid-state` | the operation is not allowed in the current state (creating a vault that exists, removing the last slot) |

A wrong passphrase and a damaged slot are distinguishable only through `commit`; once `commit` passes, a failure is
damage or an attack, never a typo.

## 13. What leaks

The store sees ciphertext and names. It learns:

- that the store is an `aparte/1` vault, the `vaultId` (in keyslot files), the number of keyslots, their kinds and
  their kdf parameters, including whether a Secret Key is used;
- the number of documents that hold data (at most 17), and per document the number of devices that wrote and, through
  `seq`, how many segments each wrote and in what order;
- how many blobs and chunks exist, each object's padded size, which chunks repeat (equal names), and from the upload
  pattern which chunks belong together;
- when each object was written and by which network client (commit times, request times), and on Git the commit
  metadata (writers use a constant commit message and author);
- which object names are fetched together, hence roughly which conversations are opened.

It does not learn: any content, any title, the number of conversations or messages (shards and segments batch them),
which device is which beyond its `dtag`, file names or types, or exact sizes.

## 14. Known limits

- **Changing the passphrase is not revocation.** The old slot wraps the same `MK`. On a store that keeps history (Git),
  anyone who has the old slot and the old passphrase (and Secret Key) still opens the vault, including data written
  after the change. Real revocation needs a new `MK` and re-encryption, planned as key epochs in a later version (the
  `epoch` byte is reserved for it).
- **Trust on first use.** A new device trusts the first state it lists ([10.4](#104-trust-on-first-use)).
- **No per-device authenticity.** Every device holds the same keys. A device, or anyone who opened the vault, can
  write objects that look as if another device wrote them (`dtag` is a name, not a signature). Signatures per device
  are planned for a later version.
- **Deletion leaves ciphertext.** Deleting a conversation, a message or a photo removes it from the documents;
  segments, chunks and manifests already written stay on the store (and in Git history) as ciphertext. Garbage
  collection is planned for a later version.
- **The Secret Key protects the remote, not the device.** Someone with a copy of the browser profile has the wrapped
  Secret Key and its device key ([11.2](#112-meta-entries)); only the passphrase and Argon2 stand between them and the
  vault.
- **Shared origin.** On `maxgfr.github.io` any page of that origin can read the IndexedDB database. It finds only
  ciphertext, keyslots and the wrapped Secret Key, but can use the device key and can delete everything.
- **A damaged object is reported, not repaired.** An object a store holds damaged is refused by every reader
  (`tampered` after a few attempts); the devices that hold an intact copy do not upload it again, since the store
  still lists the name.
- **Archives have no ZIP64:** at most 65 535 objects and 4 GiB per `.aparte.zip`.

## 15. Vectors and worked examples

[`vectors/inputs.json`](vectors/inputs.json) holds the fixed inputs; both implementations compute the vector files
from it and must produce identical bytes ([`vectors/README.md`](vectors/README.md)). [`kat/`](kat/) holds the
published known answers each implementation checks for its primitives: RFC 5869 (HKDF), RFC 4231 (HMAC), RFC 9106 and
the Argon2 reference tests (Argon2id), and Wycheproof (AES-256-GCM).

### 15.1 Encodings

- `vaultId` `f0f1…ff` (`inputs.json` → `vaultId`) is `6dy7f47u6x3pp6hz7l57z7p674` in base32.
- The `passphrase-secret-key` keyslot's `slotId` (16 bytes of `11`) is `ceirceirceirceirceirceirce`; its file is
  `keys/ceirceirceirceirceirceirce.json`. Its salt (16 bytes of `22`) is `IiIiIiIiIiIiIiIiIiIiIg` in base64url and
  its IV (12 bytes of `33`) is `MzMzMzMzMzMzMzMz`.
- Device `a` (`d0d1…df`) is `2di5fu6u2xlnpwgz3ln5zxo634` in base32 (its `dtag` is a keyed hash, in
  `vectors/names.json`).

### 15.2 Keyslot AAD

For `passphrase-secret-key` with the vector parameters, `canon(kdf)` is

```
{"alg":"argon2id","m":19456,"p":1,"salt":"IiIiIiIiIiIiIiIiIiIiIg","secretKey":true,"t":2,"v":19}
```

and `aad` is the UTF-8 of

```
aparte/1|keyslot|6dy7f47u6x3pp6hz7l57z7p674|ceirceirceirceirceirceirce|passphrase|{"alg":"argon2id","m":19456,"p":1,"salt":"IiIiIiIiIiIiIiIiIiIiIg","secretKey":true,"t":2,"v":19}
```

while the file writes `kdf` in writer order: `{"alg":"argon2id","v":19,"m":19456,"t":2,"p":1,"salt":…,"secretKey":true}`.
Its passphrase is `inputs.json` → `passphrases.unicode`; `passphrases.unicodeEquivalent` is a different string with
the same NFKC form and opens the same slot. `A`, `IKM`, `KEK`, `commit` and the file bytes are in
`vectors/keyslots.json`.

### 15.3 Envelope

The envelope `segment-plain` (`inputs.json` → `envelopes[0]`) has a 62-byte payload, kind 1, no compression and IV
`a0a1…ab`:

- header: `41505431 01 01 00 00 a0a1a2a3a4a5a6a7a8a9aaab`;
- `aad` = header `|| f0f1…ff ||` the ASCII of `d/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc`;
- `P = max(64, padme(4 + 62)) = padme(66) = 72`: plaintext `0000003e || payload || 6 zero bytes`;
- sealed length `20 + 72 + 16 = 108`.

The cases `empty`, `boundary-60` and `boundary-61` pin the padding edges: payloads of 0 and 60 bytes give `P = 64`
(sealed 100 bytes), 61 bytes gives `P = padme(65) = 72` (sealed 108). `segment-deflate` and `checkpoint-deflate` seal
the precomputed `deflated` stream with flag `01`; opening them returns `payload`. Each case of `inputs.json` →
`tamper` names a mutation; the error each must produce is the one of [7.5](#75-opening) for the step it breaks (for
example `epoch` → `unsupported-format`, `flags-compress` → `tampered` because the flag is valid for kind 1 but is
authenticated, `padding-non-zero` → `corrupt`, `truncated-short` → `corrupt`, `truncated-tag` → `tampered`).

### 15.4 Fixture

[`fixtures/sync-v1`](fixtures/README.md) is a store written once by the reference (`web/scripts/fixtures.ts`): two
devices of one vault, a folder, a conversation with a reasoning part and a photo of two chunks, checkpoints and segments
whose `seen` name each other. `fixture.json` gives the passphrase, the Secret Key and the recovery key that open it,
and what every object decodes to. Both implementations read it back in their tests (`web/src/core/sync/fixtures.test.ts`,
`crates/aparte-format/tests/fixtures.rs`); it is never regenerated or edited.

## 16. Share inbox

This section is an addition: it changes no byte of sections 1 to 15. It defines how the web app keeps what another
app shares to it (the Web Share Target of its manifest) while the vault is locked, when nothing may be decrypted and no
key is in memory. The inbox is local to one device: it is never uploaded, and a reader of a store never meets it.

### 16.1 Model

Each device has one inbox key pair per vault: an X25519 key (RFC 7748). The public key is stored in plaintext, so the
service worker can seal a share to it as the share arrives; the private key is stored wrapped by a key derived from
the master key, so only an unlocked vault can open what was sealed. A share is sealed with a fresh ephemeral key, so
the worker holds no secret and cannot open what it stored. The unlocked app opens each item, offers its content to the
user (who starts a chat with it or discards it) and deletes the item.

### 16.2 Key file

The bytes are the writer serialization ([3.4](#34-writer-serialization)) of the object below, followed by one line
feed (`0a`). Members, in writer order:

| Member | Type | Rule |
|---|---|---|
| `format` | string | exactly `aparte/1` |
| `type` | string | exactly `inbox-key` |
| `vault` | string | base32 of `vaultId` (26 chars, strict) |
| `key` | string | base64url of the 32-byte X25519 public key `P` |
| `wrap` | object | `{"iv": base64url of 12 bytes, "ct": base64url of 48 bytes}`, members in that order |

No other member is allowed at any level. A reader parses it as JSON ([3.5](#35-reading-json)); `type` other than
`inbox-key`, a missing, extra or mistyped member, a field that does not decode strictly or has the wrong length, or
bytes that differ from the serialization of the parsed value, is `corrupt`; `format` other than `aparte/1` is
`unsupported-format`.

```
d       = 32 random bytes (the X25519 scalar; RFC 7748 clamps it when used)
P       = X25519(d, 9)
K_inbox = K_local("inbox-key")                                      ; section 5.3
aad     = "aparte/1|inbox-key|" || vault || "|" || key              ; vault and key as in the file
wrap.ct = AES-GCM(K_inbox, wrap.iv, d, aad)
```

`inbox-key` is a name no local record can have (local record names are 26 base32 characters,
[11.3](#113-local-record-names)), so `K_inbox` is used for this wrap only. Creating a key draws from the RNG, in this
order: `d` (32 bytes), `wrap.iv` (12 bytes).

Opening the key: the file's `vault` must be the vault being opened (`corrupt`); decrypting `wrap.ct` must succeed
(`tampered`); and `X25519(d, 9)` must equal `P` (`tampered`). The public key is plaintext that any page of the origin
can rewrite: the last check, together with `aad`, means a planted public key is detected at the next unlock. A device
whose file does not open (another vault, a damaged or planted file, none yet) creates a new key and writes it in place
of the old one; items sealed to the old key can no longer be opened and are deleted.

### 16.3 Item

```
header  = "APX1" || 01 || 00 00 00 || epk (32) || iv (12)          ; 52 bytes
e       = 32 random bytes,  epk = X25519(e, 9)
Z       = X25519(e, P)                                              ; = X25519(d, epk)
K       = HKDF(ikm = Z, salt = vaultId || epk || P, info = "aparte/1/inbox")
aad     = header || vaultId || P
item    = header || AES-GCM(K, iv, plaintext, aad)
```

`plaintext` is laid out and padded exactly as an envelope's ([7.4](#74-plaintext-layout-and-padding)), uncompressed:
`u32be(n) || payload || zeros`, `P_len = max(64, padme(4 + n))`, with `n <= 2^26`. The item's length is therefore
`52 + P_len + 16`, at least 132. Sealing draws from the RNG, in this order: `e` (32 bytes), `iv` (12 bytes). A `Z`
of 32 zero bytes (a low-order `epk` or `P`) is refused.

### 16.4 Payload

```
payload = u32be(hlen) || header || body
```

`header` is `hlen` bytes of JSON, `1 <= hlen <= 1048576`, in writer serialization. Members, in writer order:

| Member | Type | Rule |
|---|---|---|
| `v` | integer | `1` |
| `time` | integer | when the device received the share, Unix milliseconds, in `[0, 2^53)` |
| `title` | string, optional | non-empty |
| `text` | string, optional | non-empty |
| `url` | string, optional | non-empty |
| `files` | array | at most 16 entries `{"name": string, "type": string, "size": integer}`, members in that order |

A file `name` is 1 to 255 UTF-16 code units; `type` is a lowercase media type of at most 127 characters
(`[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*`); `size` is a non-negative integer. `body` is the files'
bytes, concatenated in `files` order: the sizes add up to its length. Every string is well-formed
([section 1](#1-conventions)). A reader rejects any other member, a missing or mistyped one, a header that is not its
own writer serialization, or sizes that do not add up (`corrupt`).

### 16.5 Opening an item

A reader MUST check, in this order:

| Step | Check | Error |
|---|---|---|
| 1 | length at least 132 | `corrupt` |
| 2 | magic is `APX1` | `corrupt` |
| 3 | version is `01` | `unsupported-format` |
| 4 | the 3 reserved bytes are `00` | `corrupt` |
| 5 | `epk` is a usable X25519 public key and `Z` is not all zero | `corrupt` |
| 6 | AES-GCM decryption with `K` and `aad` succeeds | `tampered` |
| 7 | `n <= P_len - 4`, `P_len == max(64, padme(4 + n))`, every padding byte is `00` | `corrupt` |
| 8 | the payload follows [16.4](#164-payload) | `corrupt` |

### 16.6 Storage

IndexedDB database `aparte-inbox-v1`, schema version 1, beside `aparte-v1` (whose schema,
[11.1](#111-database), is unchanged), two object stores with out-of-line string keys:

| Store | Key | Value | Plaintext? |
|---|---|---|---|
| `key` | `inbox-key` | string, the key file ([16.2](#162-key-file)) | public key and ciphertext only |
| `items` | base32 of 16 random bytes | bytes, one item ([16.3](#163-item)) | ciphertext |

At most 32 items wait at a time; the service worker refuses a share past that, and one whose payload would exceed
`2^26` bytes. The service worker never creates the database: without a key file there is nothing to seal to, and the
share is refused. What leaks to someone who reads the device: that shares are waiting, how many, their padded sizes
and when they were stored (from the browser's own metadata), never their content, type or origin.

### 16.7 Worked example

With `vaultId` and `mk` of `inputs.json`, `d` = Alice's scalar of RFC 7748 section 6.1
(`77076d0a…1db92c2a`) and `wrap.iv` = 12 bytes of `44`: `P` is Alice's public key of the RFC (`8520f009…aa9b4e6a`),
so the key file's public key member is its base64url `hSDwCYkw…qqbTmo`, `wrap.ct` (48 bytes) begins `47b4f7`, and the
235-byte file, its final line feed included, has the SHA-256
`3e8de08e8f80e338c10fa9dcd3fb5d9ee163c4bf6324288fb722e5f005643cb8`.

Sealing to it, with `e` = Bob's scalar (`5dab087e…ff88e0eb`, so `epk` is Bob's public key and `Z` is the RFC's
shared secret `4a5d9d5b…1e161742`) and `iv` = 12 bytes of `55`, the 257-byte payload of the share
`{"v":1,"time":1760000000000,"title":"A title","text":"canary-share-91c2-the-shared-text-never-rests-in-clear","url":"https://example.org/page","files":[{"name":"one.jpg","type":"image/jpeg","size":3},{"name":"two.png","type":"image/png","size":2}]}`
with body `01 02 03 04 05` gives a 340-byte item (`P_len = padme(261) = 272`) whose SHA-256 is
`6c02d2952f6a560031a1708b68b7bbb36a3eda81d507363404cd78e54d9202fd`. The CLI never reads an inbox, so these values are
checked by the web implementation's tests (`web/src/core/inbox/inbox.test.ts`) rather than by the cross-implementation
vector files of [section 15](#15-vectors-and-worked-examples).
