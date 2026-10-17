/*
 * Contracts of the aparte/1 crypto layer (spec/FORMAT.md). Types only, plus the error classes every module throws:
 * the implementations live in web/src/core/crypto/*.ts and each one satisfies the `*Module` interface named after
 * it, which its tests assert at compile time.
 *
 * Invariants shared by every module:
 * - Bytes returned are always backed by an ArrayBuffer (never a SharedArrayBuffer), so they can be passed to WebCrypto
 *   as a BufferSource without a copy. Inputs may be any Uint8Array and are never mutated.
 * - Secret key material is held as non-extractable CryptoKey objects. Raw secret bytes (the master key, an Argon2
 *   output) exist only inside a function call and are zeroed before it returns, where the platform allows.
 * - All randomness comes from an injected Rng, so the vectors are reproducible and production uses the CSPRNG.
 */

/** A byte string backed by an ArrayBuffer. */
export type Bytes = Uint8Array<ArrayBuffer>

/** A JSON value as `canonicalJson` accepts it (spec/FORMAT.md section 3.3). */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** Source of random bytes. Production draws from crypto.getRandomValues; tests and vectors inject a fixed sequence. */
export interface Rng {
  /** Returns `n` fresh bytes. */
  bytes(n: number): Bytes
}

// Errors

/** Stable error codes (spec/FORMAT.md section 12). The UI and the CLI branch on these, never on messages. */
export type ErrorCode =
  | 'wrong-secret'
  | 'unsupported-keyslot'
  | 'unsupported-format'
  | 'corrupt'
  | 'tampered'
  | 'locked'
  | 'invalid-input'
  | 'invalid-state'

/** Base class of every error the crypto, vault and store layers throw on purpose. */
export class AparteError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** The passphrase, Secret Key, recovery key or passkey output does not open the keyslot (its commitment differs). */
export class WrongSecretError extends AparteError {
  constructor(message = 'This secret does not open the vault', options?: ErrorOptions) {
    super('wrong-secret', message, options)
  }
}

/** A keyslot this build refuses to run: another format, an unknown kind or algorithm, or a parameter out of bounds. */
export class UnsupportedKeyslotError extends AparteError {
  constructor(message = 'Unsupported keyslot', options?: ErrorOptions) {
    super('unsupported-keyslot', message, options)
  }
}

/** An envelope or store of another format version or key epoch. */
export class UnsupportedFormatError extends AparteError {
  constructor(message = 'Unsupported format version', options?: ErrorOptions) {
    super('unsupported-format', message, options)
  }
}

/** Malformed data: bad JSON, bad encoding, bad length, bad padding, or a header or name that does not match. */
export class CorruptError extends AparteError {
  constructor(message = 'Corrupt data', options?: ErrorOptions) {
    super('corrupt', message, options)
  }
}

/** Authentication failed: an AES-GCM tag, or the master key check after a successful unwrap. */
export class TamperedError extends AparteError {
  constructor(message = 'Data does not authenticate', options?: ErrorOptions) {
    super('tampered', message, options)
  }
}

/** The operation needs the vault's keys and the vault is locked. */
export class LockedError extends AparteError {
  constructor(message = 'The vault is locked', options?: ErrorOptions) {
    super('locked', message, options)
  }
}

/** A caller or user input is malformed: an empty passphrase, a mistyped Secret Key, a bad base32 string. */
export class InvalidInputError extends AparteError {
  constructor(message = 'Invalid input', options?: ErrorOptions) {
    super('invalid-input', message, options)
  }
}

/** The operation is not allowed in the current state, such as creating a vault that exists. */
export class InvalidStateError extends AparteError {
  constructor(message = 'Not allowed in the current state', options?: ErrorOptions) {
    super('invalid-state', message, options)
  }
}

// bytes.ts

export interface BytesModule {
  /** UTF-8 of a well-formed string; InvalidInputError on a lone surrogate. */
  utf8(text: string): Bytes
  /** Strict UTF-8 decode; InvalidInputError on invalid UTF-8. */
  fromUtf8(bytes: Uint8Array): string
  concat(...parts: readonly Uint8Array[]): Bytes
  /** Equality that runs in time independent of the contents when the lengths are equal. */
  equal(a: Uint8Array, b: Uint8Array): boolean
  /** RangeError outside [0, 2^32). */
  u32be(n: number): Bytes
  readU32be(bytes: Uint8Array, offset: number): number
  /** Lowercase hex. */
  toHex(bytes: Uint8Array): string
  /** Strict lowercase hex of even length; InvalidInputError otherwise. */
  fromHex(hex: string): Bytes
  /** Lowercase RFC 4648 base32 without padding (spec/FORMAT.md section 3.1). */
  base32Encode(bytes: Uint8Array): string
  /** Strict decode: lowercase alphabet only, no padding, valid length, zero trailing bits; InvalidInputError. */
  base32Decode(text: string): Bytes
  /** RFC 4648 base64url without padding (spec/FORMAT.md section 3.2). */
  base64urlEncode(bytes: Uint8Array): string
  /** Strict decode: no padding, url alphabet only, valid length, zero trailing bits; InvalidInputError. */
  base64urlDecode(text: string): Bytes
  /** RFC 8785 canonical JSON for strings, booleans, null, arrays, objects and safe integers. */
  canonicalJson(value: JsonValue): string
}

// keys.ts

/** The six subkeys of a vault (spec/FORMAT.md section 5.2), all non-extractable. */
export interface Subkeys {
  /** The vault they belong to; not secret, carried along because every derivation needs it. */
  readonly vaultId: Bytes
  /** HKDF key: derives the AES key of each remote object. */
  readonly objEnc: CryptoKey
  /** HMAC key: device, document and secret tags, shard choice, name suffixes. */
  readonly objName: CryptoKey
  /** HMAC key: blob chunk and manifest ids. */
  readonly blobId: CryptoKey
  /** HKDF key: derives the AES key of each local record. */
  readonly localEnc: CryptoKey
  /** HMAC key: local record names. */
  readonly localName: CryptoKey
  /** HMAC key: the master key check. */
  readonly check: CryptoKey
}

export interface KeysModule {
  sha256(data: Uint8Array): Promise<Bytes>
  /** HMAC-SHA-256 with raw key bytes (any length, as RFC 4231 allows) or an HMAC CryptoKey. */
  hmacSha256(key: Uint8Array | CryptoKey, data: Uint8Array): Promise<Bytes>
  /** RFC 5869 HKDF-SHA-256; `length` defaults to 32 and may be up to 8160. An empty salt is allowed. */
  hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length?: number): Promise<Bytes>
  /** AES-256-GCM with a 12-byte IV; returns ciphertext || 16-byte tag. A raw key is imported, never kept. */
  aesGcmEncrypt(key: Uint8Array | CryptoKey, iv: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Bytes>
  /** Inverse of aesGcmEncrypt; TamperedError when the tag does not verify. */
  aesGcmDecrypt(key: Uint8Array | CryptoKey, iv: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Bytes>
  /** The key schedule of spec/FORMAT.md section 5.2; the master key bytes are not retained. */
  deriveSubkeys(mk: Uint8Array, vaultId: Uint8Array): Promise<Subkeys>
  /** K_obj(name): non-extractable AES-256-GCM key of one remote object name. */
  objectKey(subkeys: Subkeys, name: string): Promise<CryptoKey>
  /** K_local(name): non-extractable AES-256-GCM key of one local record name. */
  localKey(subkeys: Subkeys, localName: string): Promise<CryptoKey>
  /** mkCheck = HMAC(K_check, "aparte/1/check|" || vaultId). */
  masterKeyCheck(subkeys: Subkeys): Promise<Bytes>
}

// padme.ts

export interface PadmeModule {
  /** Padmé length for a non-negative safe integer below 2^31 (spec/FORMAT.md section 7.4). */
  padme(length: number): number
  /** Envelope plaintext size for a payload' of `payloadLength` bytes: max(64, padme(4 + payloadLength)). */
  paddedSize(payloadLength: number): number
}

// envelope.ts

/** 1 segment, 2 checkpoint, 3 blob chunk, 4 blob manifest, 5 secret version, 6 local record. */
export type EnvelopeKind = 1 | 2 | 3 | 4 | 5 | 6

export interface EnvelopeHeader {
  readonly version: 1
  readonly kind: EnvelopeKind
  readonly flags: number
  readonly epoch: 0
  readonly iv: Bytes
}

/**
 * How the payload is stored. `deflate-raw` compresses it; `precompressed` means `payload` already is a deflate-raw
 * stream, sealed as it is (the vectors use it, since compressed bytes differ between libraries). Both are refused for
 * kinds 3 to 6.
 */
export type Compression = 'none' | 'deflate-raw' | 'precompressed'

export interface SealInput {
  readonly kind: EnvelopeKind
  /** The remote object name (kinds 1 to 5) or the local record name (kind 6); it selects the key and enters the AAD. */
  readonly name: string
  readonly payload: Uint8Array
  readonly compression?: Compression
}

export interface OpenInput {
  /** The kind the name implies; an envelope of another kind is corrupt. */
  readonly kind: EnvelopeKind
  readonly name: string
  readonly bytes: Uint8Array
}

export interface EnvelopeModule {
  /** Seals per spec/FORMAT.md section 7.6, drawing exactly one 12-byte IV from `rng`. */
  sealEnvelope(subkeys: Subkeys, input: SealInput, rng: Rng): Promise<Bytes>
  /** Opens per spec/FORMAT.md section 7.5, in that order, and returns the (inflated) payload. */
  openEnvelope(subkeys: Subkeys, input: OpenInput): Promise<Bytes>
  /** Structural checks of section 7.5 steps 1 to 6 without decrypting (any kind accepted at step 4). */
  parseEnvelopeHeader(bytes: Uint8Array): EnvelopeHeader
}

// names.ts

export type ShardId =
  | 'c00'
  | 'c01'
  | 'c02'
  | 'c03'
  | 'c04'
  | 'c05'
  | 'c06'
  | 'c07'
  | 'c08'
  | 'c09'
  | 'c10'
  | 'c11'
  | 'c12'
  | 'c13'
  | 'c14'
  | 'c15'

/** The 17 synced documents (spec/DATA-MODEL.md section 1). */
export type DocId = 'index' | ShardId

/** A remote object name, parsed strictly (spec/FORMAT.md section 8.8). */
export type ParsedName =
  | { readonly type: 'fmt' }
  | { readonly type: 'keyslot'; readonly slot: string }
  | { readonly type: 'segment'; readonly stag: string; readonly dtag: string; readonly seq: number; readonly r: string }
  | {
      readonly type: 'checkpoint'
      readonly stag: string
      readonly dtag: string
      readonly seq: number
      readonly r: string
    }
  | { readonly type: 'chunk'; readonly id: string }
  | { readonly type: 'manifest'; readonly id: string }
  | { readonly type: 'secret'; readonly ktag: string; readonly seq: number; readonly r: string }

export interface StreamNameInput {
  readonly docId: DocId
  readonly deviceId: Uint8Array
  /** 1 to 9 999 999 999; InvalidInputError otherwise. */
  readonly seq: number
  /** The uncompressed payload; the name never depends on the ciphertext. */
  readonly payload: Uint8Array
}

export interface SecretNameInput {
  readonly secretId: Uint8Array
  readonly seq: number
  readonly payload: Uint8Array
}

export interface NamesModule {
  /** `keys/<slotId b32>.json`. */
  keyslotName(slotId: Uint8Array): string
  deviceTag(subkeys: Subkeys, deviceId: Uint8Array): Promise<string>
  docTag(subkeys: Subkeys, docId: DocId): Promise<string>
  shardOf(subkeys: Subkeys, convId: Uint8Array): Promise<ShardId>
  segmentName(subkeys: Subkeys, input: StreamNameInput): Promise<string>
  checkpointName(subkeys: Subkeys, input: StreamNameInput): Promise<string>
  chunkId(subkeys: Subkeys, chunk: Uint8Array): Promise<string>
  chunkName(id: string): string
  manifestId(subkeys: Subkeys, manifest: Uint8Array): Promise<string>
  manifestName(id: string): string
  secretTag(subkeys: Subkeys, secretId: Uint8Array): Promise<string>
  secretVersionName(subkeys: Subkeys, input: SecretNameInput): Promise<string>
  /** Local record name (spec/FORMAT.md section 11.3); `purpose` must match [a-z][a-z0-9-]{0,31}. */
  localName(subkeys: Subkeys, purpose: string, id: string): Promise<string>
  /** Strict parse; null for anything that is not exactly one of the forms of spec/FORMAT.md section 8.8. */
  parseName(name: string): ParsedName | null
}

// argon2.ts

export interface Argon2Params {
  /** Memory in KiB. */
  readonly m: number
  /** Passes. */
  readonly t: number
  /** Lanes. */
  readonly p: number
}

export interface Argon2Input extends Argon2Params {
  readonly password: Uint8Array
  readonly salt: Uint8Array
  /** Tag length in bytes. */
  readonly length: number
  /** Optional secret K of RFC 9106 (never used by the format; exposed for known-answer tests). */
  readonly secret?: Uint8Array
}

/**
 * Argon2id version 0x13. Injectable so a worker-backed implementation can keep the UI responsive; it enforces no
 * vault bounds (the keyslot layer does, before calling it).
 */
export type Argon2Fn = (input: Argon2Input) => Promise<Bytes>

export interface Argon2Module {
  argon2id: Argon2Fn
}

// keyslot.ts

export type KeyslotKind = 'passphrase' | 'recovery' | 'passkey'

export interface PassphraseKdf {
  readonly alg: 'argon2id'
  readonly v: 19
  readonly m: number
  readonly t: number
  readonly p: number
  /** base64url of 16 bytes. */
  readonly salt: string
  readonly secretKey: boolean
}

export interface RecoveryKdf {
  readonly alg: 'recovery'
}

export interface PasskeyKdf {
  readonly alg: 'prf'
  readonly credentialId: string
  readonly rpId: string
  readonly prfSalt: string
}

interface KeyslotCommon {
  readonly format: 'aparte/1'
  readonly type: 'keyslot'
  /** base32 vaultId. */
  readonly vault: string
  /** base32 slotId. */
  readonly slot: string
  /** base64url of 32 bytes. */
  readonly commit: string
  readonly wrap: { readonly iv: string; readonly ct: string }
  /** base64url of 32 bytes. */
  readonly mkCheck: string
}

/** A parsed keyslot file (spec/FORMAT.md section 6.2). */
export type Keyslot =
  | (KeyslotCommon & { readonly kind: 'passphrase'; readonly kdf: PassphraseKdf })
  | (KeyslotCommon & { readonly kind: 'recovery'; readonly kdf: RecoveryKdf })
  | (KeyslotCommon & { readonly kind: 'passkey'; readonly kdf: PasskeyKdf })

/** What opens a keyslot. */
export type SlotSecret =
  | { readonly kind: 'passphrase'; readonly passphrase: string; readonly secretKey: Uint8Array | null }
  | { readonly kind: 'recovery'; readonly recoveryKey: Uint8Array }
  | { readonly kind: 'passkey'; readonly prfOutput: Uint8Array }

interface CreateCommon {
  /** The 32-byte master key; read, never retained. */
  readonly mk: Uint8Array
  readonly vaultId: Uint8Array
}

export type CreateKeyslotInput =
  | (CreateCommon & {
      readonly kind: 'passphrase'
      readonly passphrase: string
      /** The 16-byte Secret Key, or null for a slot opened by the passphrase alone. */
      readonly secretKey: Uint8Array | null
      /** Defaults to DEFAULT_ARGON2; must be within ARGON2_BOUNDS. */
      readonly argon2?: Argon2Params
    })
  | (CreateCommon & { readonly kind: 'recovery'; readonly recoveryKey: Uint8Array })
  | (CreateCommon & {
      readonly kind: 'passkey'
      readonly prfOutput: Uint8Array
      readonly credentialId: Uint8Array
      readonly rpId: string
      readonly prfSalt: Uint8Array
    })

export interface Argon2Bounds {
  readonly m: readonly [min: number, max: number]
  readonly t: readonly [min: number, max: number]
  readonly p: readonly [min: number, max: number]
}

export interface KeyslotModule {
  /** m = 65536, t = 3, p = 1: fixed, never calibrated. */
  readonly DEFAULT_ARGON2: Argon2Params
  /** m in [19456, 262144], t in [2, 10], p in [1, 4]. */
  readonly ARGON2_BOUNDS: Argon2Bounds
  /** UTF-8 of NFKC(passphrase); InvalidInputError when empty after normalization or not well-formed. */
  normalizePassphrase(passphrase: string): Bytes
  /** Creates a slot, drawing slotId, then salt (passphrase only), then the wrap IV from `rng`. */
  createKeyslot(input: CreateKeyslotInput, deps: { readonly rng: Rng; readonly argon2?: Argon2Fn }): Promise<Keyslot>
  /**
   * Opens a slot per spec/FORMAT.md section 6.7 and returns the master key (the caller zeroes it). The slot object is
   * validated again, so a hand-built object with an out-of-bounds parameter is rejected before Argon2 runs.
   */
  openKeyslot(
    slot: Keyslot,
    secret: SlotSecret,
    options: { readonly vaultId: Uint8Array; readonly argon2?: Argon2Fn },
  ): Promise<Bytes>
  /** Strict parse of a keyslot file; `name`, when given, must be the file's `keys/<slot>.json`. */
  parseKeyslot(bytes: Uint8Array, expected?: { readonly name?: string }): Keyslot
  /** Writer serialization plus a final line feed (spec/FORMAT.md section 6.1). */
  serializeKeyslot(slot: Keyslot): Bytes
  /** The wrap's associated data (spec/FORMAT.md section 6.5). */
  keyslotAad(slot: Keyslot): Bytes
}

// secretKey.ts

export interface SecretKeyModule {
  /** 16 bytes from `rng`. */
  generateSecretKey(rng: Rng): Bytes
  /**
   * Emergency Kit text `A1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (spec/FORMAT.md section 6.8). Asynchronous because the
   * checksum is a SHA-256 and WebCrypto only hashes asynchronously.
   */
  formatSecretKey(secretKey: Uint8Array): Promise<string>
  /** Case-insensitive, ignores spaces and hyphens, verifies the checksum; rejects with InvalidInputError otherwise. */
  parseSecretKey(text: string): Promise<Bytes>
}

// recovery.ts

export interface RecoveryModule {
  /** 32 bytes from `rng`. */
  generateRecoveryKey(rng: Rng): Bytes
  /** 52 uppercase base32 characters in 13 groups of 4 (spec/FORMAT.md section 6.9). */
  formatRecoveryKey(recoveryKey: Uint8Array): string
  /** Case-insensitive, ignores spaces and hyphens, strict base32 of exactly 32 bytes; InvalidInputError otherwise. */
  parseRecoveryKey(text: string): Bytes
}

// rng.ts

/** An Rng that hands out a fixed list of values, for the vectors. */
export interface QueueRng extends Rng {
  /** Values not drawn yet. */
  remaining(): number
}

export interface RngModule {
  /** crypto.getRandomValues. */
  cryptoRng(): Rng
  /**
   * Returns the values in order; a draw whose length differs from the next value, or a draw past the end, throws
   * InvalidStateError, so a vector that consumes randomness in another order fails loudly.
   */
  queueRng(values: readonly Uint8Array[]): QueueRng
  /** Deterministic, NOT cryptographic: tests only. */
  seededRng(seed: number): Rng
}
