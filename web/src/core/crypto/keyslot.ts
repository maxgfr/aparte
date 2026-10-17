/*
 * Keyslots of spec/FORMAT.md section 6. A keyslot wraps the master key under a secret the user holds; it is plaintext
 * JSON valid only in its single canonical form. Opening follows section 6.7 step by step: structure (corrupt), then
 * the format and every kdf bound (unsupported-keyslot) before anything costly runs, then the canonical form, the
 * vault, the secret, the commitment (wrong-secret), the wrap and mkCheck (tampered).
 */
import {
  type Argon2Bounds,
  type Argon2Fn,
  type Argon2Params,
  type Bytes,
  CorruptError,
  type CreateKeyslotInput,
  InvalidInputError,
  type JsonValue,
  type Keyslot,
  type KeyslotKind,
  type PasskeyKdf,
  type PassphraseKdf,
  type Rng,
  type SlotSecret,
  TamperedError,
  UnsupportedKeyslotError,
  WrongSecretError,
} from '../contracts/crypto.ts'
import { argon2id as defaultArgon2 } from './argon2.ts'
import {
  base32Decode,
  base32Encode,
  base64urlDecode,
  base64urlEncode,
  canonicalJson,
  concat,
  equal,
  fromUtf8,
  isWellFormed,
  utf8,
  zero,
} from './bytes.ts'
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  deriveSubkeys,
  hkdfAesKey,
  hkdfHkdfKey,
  hkdfHmacKey,
  hmacSha256,
  importHkdfKey,
  masterKeyCheck,
} from './keys.ts'

const FORMAT = 'aparte/1'

export const DEFAULT_ARGON2: Argon2Params = Object.freeze({ m: 65536, t: 3, p: 1 })

export const ARGON2_BOUNDS: Argon2Bounds = Object.freeze({
  m: Object.freeze([19456, 262144] as const),
  t: Object.freeze([2, 10] as const),
  p: Object.freeze([1, 4] as const),
})

const RP_ID = /^[a-z0-9.-]{1,253}$/
const KINDS: readonly KeyslotKind[] = ['passphrase', 'recovery', 'passkey']
const TOP_MEMBERS = ['format', 'type', 'vault', 'slot', 'kind', 'kdf', 'commit', 'wrap', 'mkCheck'] as const
const PASSPHRASE_MEMBERS = ['alg', 'v', 'm', 't', 'p', 'salt', 'secretKey'] as const
const RECOVERY_MEMBERS = ['alg'] as const
const PASSKEY_MEMBERS = ['alg', 'credentialId', 'rpId', 'prfSalt'] as const

export function normalizePassphrase(passphrase: string): Bytes {
  if (typeof passphrase !== 'string' || !isWellFormed(passphrase)) {
    throw new InvalidInputError('The passphrase is not well-formed text')
  }
  const normalized = passphrase.normalize('NFKC')
  if (normalized.length === 0) throw new InvalidInputError('The passphrase is empty')
  return utf8(normalized)
}

// Validation shared by parseKeyslot and openKeyslot

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** True when `o` has exactly the members `names`, as own enumerable keys. */
function hasExactly(o: Json, names: readonly string[]): boolean {
  const keys = Object.keys(o)
  return keys.length === names.length && names.every((name) => Object.hasOwn(o, name))
}

/** Strict base64url of exactly `length` bytes (or within [min, max]); null otherwise. */
function b64(value: unknown, min: number, max = min): Bytes | null {
  if (typeof value !== 'string') return null
  try {
    const bytes = base64urlDecode(value)
    return bytes.length >= min && bytes.length <= max ? bytes : null
  } catch {
    return null
  }
}

/** Strict base32 of exactly 16 bytes; null otherwise. */
function b32id(value: unknown): Bytes | null {
  if (typeof value !== 'string') return null
  try {
    const bytes = base32Decode(value)
    return bytes.length === 16 ? bytes : null
  } catch {
    return null
  }
}

const inRange = (value: unknown, [min, max]: readonly [number, number]): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

/** Step 1 of section 6.7 on a parsed value: every member outside `kdf`. */
function checkStructure(o: unknown, expectedSlot?: string): asserts o is Json {
  if (!isObject(o)) throw new CorruptError('A keyslot is a JSON object')
  if (!hasExactly(o, TOP_MEMBERS)) throw new CorruptError('Keyslot members missing or extra')
  for (const name of ['format', 'type', 'vault', 'slot', 'kind', 'commit', 'mkCheck'] as const) {
    if (typeof o[name] !== 'string') throw new CorruptError(`Keyslot member ${name} is not a string`)
  }
  if (!isObject(o.kdf)) throw new CorruptError('Keyslot kdf is not an object')
  if (o.type !== 'keyslot') throw new CorruptError('Not a keyslot')
  if (!b32id(o.vault)) throw new CorruptError('Keyslot vault id is not strict base32 of 16 bytes')
  if (!b32id(o.slot)) throw new CorruptError('Keyslot slot id is not strict base32 of 16 bytes')
  if (expectedSlot !== undefined && o.slot !== expectedSlot)
    throw new CorruptError('Keyslot slot differs from its name')
  if (!b64(o.commit, 32)) throw new CorruptError('Keyslot commit is not base64url of 32 bytes')
  if (!b64(o.mkCheck, 32)) throw new CorruptError('Keyslot mkCheck is not base64url of 32 bytes')
  const wrap = o.wrap
  if (!isObject(wrap) || !hasExactly(wrap, ['iv', 'ct'])) throw new CorruptError('Keyslot wrap is not {iv, ct}')
  if (!b64(wrap.iv, 12)) throw new CorruptError('Keyslot wrap iv is not base64url of 12 bytes')
  if (!b64(wrap.ct, 48)) throw new CorruptError('Keyslot wrap ct is not base64url of 48 bytes')
}

/** Step 2 of section 6.7: the format, the kind and every rule of section 6.3. */
function checkKdf(o: Json): void {
  if (o.format !== FORMAT) throw new UnsupportedKeyslotError(`Keyslot format ${String(o.format)}`)
  const kind = o.kind as string
  if (!(KINDS as readonly string[]).includes(kind)) throw new UnsupportedKeyslotError(`Keyslot kind ${kind}`)
  const kdf = o.kdf as Json
  const fail = (rule: string): never => {
    throw new UnsupportedKeyslotError(`Keyslot kdf: ${rule}`)
  }
  if (kind === 'passphrase') {
    if (!hasExactly(kdf, PASSPHRASE_MEMBERS)) fail('members missing or extra')
    if (kdf.alg !== 'argon2id') fail('alg is not argon2id')
    if (kdf.v !== 19) fail('version is not 19')
    if (!inRange(kdf.m, ARGON2_BOUNDS.m)) fail('m out of bounds')
    if (!inRange(kdf.t, ARGON2_BOUNDS.t)) fail('t out of bounds')
    if (!inRange(kdf.p, ARGON2_BOUNDS.p)) fail('p out of bounds')
    if (!b64(kdf.salt, 16)) fail('salt is not base64url of 16 bytes')
    if (typeof kdf.secretKey !== 'boolean') fail('secretKey is not a boolean')
  } else if (kind === 'recovery') {
    if (!hasExactly(kdf, RECOVERY_MEMBERS)) fail('members missing or extra')
    if (kdf.alg !== 'recovery') fail('alg is not recovery')
  } else {
    if (!hasExactly(kdf, PASSKEY_MEMBERS)) fail('members missing or extra')
    if (kdf.alg !== 'prf') fail('alg is not prf')
    if (!b64(kdf.credentialId, 16, 1023)) fail('credentialId is not base64url of 16 to 1023 bytes')
    if (typeof kdf.rpId !== 'string' || !RP_ID.test(kdf.rpId)) fail('rpId is not 1 to 253 of [a-z0-9.-]')
    if (!b64(kdf.prfSalt, 32)) fail('prfSalt is not base64url of 32 bytes')
  }
}

/** A fresh Keyslot from a value that passed steps 1 and 2, with members in writer order. */
function build(o: Json): Keyslot {
  const kdf = o.kdf as Json
  const wrap = o.wrap as Json
  const common = {
    format: FORMAT,
    type: 'keyslot',
    vault: o.vault as string,
    slot: o.slot as string,
  } as const
  const tail = {
    commit: o.commit as string,
    wrap: { iv: wrap.iv as string, ct: wrap.ct as string },
    mkCheck: o.mkCheck as string,
  }
  if (o.kind === 'passphrase') {
    const passphrase: PassphraseKdf = {
      alg: 'argon2id',
      v: 19,
      m: kdf.m as number,
      t: kdf.t as number,
      p: kdf.p as number,
      salt: kdf.salt as string,
      secretKey: kdf.secretKey as boolean,
    }
    return { ...common, kind: 'passphrase', kdf: passphrase, ...tail }
  }
  if (o.kind === 'recovery') return { ...common, kind: 'recovery', kdf: { alg: 'recovery' }, ...tail }
  const passkey: PasskeyKdf = {
    alg: 'prf',
    credentialId: kdf.credentialId as string,
    rpId: kdf.rpId as string,
    prfSalt: kdf.prfSalt as string,
  }
  return { ...common, kind: 'passkey', kdf: passkey, ...tail }
}

/** Steps 1 and 2 on an object, as openKeyslot needs for a slot built by hand. */
function validate(value: unknown, expectedSlot?: string): Keyslot {
  checkStructure(value, expectedSlot)
  checkKdf(value)
  return build(value)
}

const KEYSLOT_NAME = /^keys\/([a-z2-7]{26})\.json$/

const hexUnit = (text: string, at: number): number | null => {
  const hex = text.slice(at, at + 4)
  return /^[0-9A-Fa-f]{4}$/.test(hex) ? Number.parseInt(hex, 16) : null
}

/**
 * Whether a JSON text holds a `\u` escape of a surrogate that is not the high half of a high-low pair followed by its
 * low half (section 6.7 step 1). Decoded UTF-8 never holds a surrogate, so a lone one can only come from such an
 * escape. Outside strings a backslash is not JSON, and inside one it always starts an escape, so scanning escapes
 * from the left finds exactly those JSON.parse decodes, whichever member they are in (even one a later duplicate
 * replaces). The Rust reader runs the same scan on the same text.
 */
function hasLoneSurrogateEscape(text: string): boolean {
  let i = 0
  while (i < text.length) {
    if (text[i] !== '\\') {
      i += 1
      continue
    }
    if (text[i + 1] !== 'u') {
      i += 2
      continue
    }
    const unit = hexUnit(text, i + 2)
    if (unit !== null && unit >= 0xd800 && unit <= 0xdbff) {
      const low = text[i + 6] === '\\' && text[i + 7] === 'u' ? hexUnit(text, i + 8) : null
      if (low === null || low < 0xdc00 || low > 0xdfff) return true
      i += 12
    } else if (unit !== null && unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    } else {
      i += 2
    }
  }
  return false
}

export function parseKeyslot(bytes: Uint8Array, expected?: { readonly name?: string }): Keyslot {
  let expectedSlot: string | undefined
  if (expected?.name !== undefined) {
    const m = KEYSLOT_NAME.exec(expected.name)
    if (!m) throw new CorruptError('Not a keyslot file name')
    expectedSlot = m[1]
  }
  let text = ''
  let value: unknown
  try {
    text = fromUtf8(bytes)
    value = JSON.parse(text)
  } catch (cause) {
    throw new CorruptError('A keyslot file is UTF-8 JSON', { cause })
  }
  // Section 1: a stored string is well-formed Unicode, and JSON.parse would let an escaped lone surrogate through.
  if (hasLoneSurrogateEscape(text)) throw new CorruptError('A keyslot holds a lone surrogate')
  const slot = validate(value, expectedSlot)
  // Step 3: the file is valid only in its single canonical form.
  if (!equal(serializeKeyslot(slot), bytes)) throw new CorruptError('Keyslot file is not in canonical form')
  return slot
}

export function serializeKeyslot(slot: Keyslot): Bytes {
  // Rebuilt member by member, so the output is in writer order whatever the order of the object given.
  const ordered = build(slot as unknown as Json)
  return utf8(`${JSON.stringify(ordered)}\n`)
}

export function keyslotAad(slot: Keyslot): Bytes {
  const kdf = canonicalJson(slot.kdf as unknown as JsonValue)
  return utf8(`aparte/1|keyslot|${slot.vault}|${slot.slot}|${slot.kind}|${kdf}`)
}

// Key derivation (section 6.5)

interface SlotKeys {
  readonly commit: Bytes
  readonly wrapKey: CryptoKey
}

/**
 * KEK = HKDF(IKM, vaultId || slotId, "aparte/1/kek|" || kind); K_wrap and K_commit from KEK; commit. Only the IKM
 * (zeroed by the caller) and, inside hkdfHkdfKey, the KEK bytes ever exist as raw bytes.
 */
async function slotKeys(
  ikm: Uint8Array,
  vaultId: Uint8Array,
  slotId: Uint8Array,
  kind: KeyslotKind,
): Promise<SlotKeys> {
  const ikmKey = await importHkdfKey(ikm)
  const kek = await hkdfHkdfKey(ikmKey, concat(vaultId, slotId), utf8(`aparte/1/kek|${kind}`))
  const [commitKey, wrapKey] = await Promise.all([
    hkdfHmacKey(kek, vaultId, utf8('aparte/1/commit')),
    hkdfAesKey(kek, vaultId, utf8('aparte/1/wrap')),
  ])
  const commit = await hmacSha256(commitKey, concat(utf8('aparte/1/commit|'), vaultId, slotId))
  return { commit, wrapKey }
}

async function mkCheckOf(mk: Uint8Array, vaultId: Uint8Array): Promise<Bytes> {
  return masterKeyCheck(await deriveSubkeys(mk, vaultId))
}

/** IKM of a passphrase slot: A, or A || SK (section 6.4). The Argon2 output is zeroed once concatenated. */
async function passphraseIkm(
  password: Uint8Array,
  kdf: Pick<PassphraseKdf, 'm' | 't' | 'p'>,
  salt: Uint8Array,
  secretKey: Uint8Array | null,
  argon2: Argon2Fn,
): Promise<Bytes> {
  const a = await argon2({ password, salt, m: kdf.m, t: kdf.t, p: kdf.p, length: 32 })
  if (a.length !== 32) throw new InvalidInputError('Argon2 returned a tag of the wrong length')
  if (!secretKey) return a
  const ikm = concat(a, secretKey)
  zero(a)
  return ikm
}

function requireBytes(value: unknown, length: number, what: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new InvalidInputError(`${what} must be ${length} bytes`)
  }
}

function checkArgon2Params(params: Argon2Params): void {
  if (
    !inRange(params.m, ARGON2_BOUNDS.m) ||
    !inRange(params.t, ARGON2_BOUNDS.t) ||
    !inRange(params.p, ARGON2_BOUNDS.p)
  ) {
    throw new InvalidInputError('Argon2 parameters out of bounds')
  }
}

export async function createKeyslot(
  input: CreateKeyslotInput,
  deps: { readonly rng: Rng; readonly argon2?: Argon2Fn },
): Promise<Keyslot> {
  const { rng } = deps
  const argon2 = deps.argon2 ?? defaultArgon2
  requireBytes(input.mk, 32, 'The master key')
  requireBytes(input.vaultId, 16, 'The vault id')

  // Every input is checked before the RNG is drawn from, so a refused call consumes nothing.
  let password: Bytes | null = null
  let params: Argon2Params = DEFAULT_ARGON2
  if (input.kind === 'passphrase') {
    if (input.secretKey !== null) requireBytes(input.secretKey, 16, 'The Secret Key')
    params = input.argon2 ?? DEFAULT_ARGON2
    checkArgon2Params(params)
    password = normalizePassphrase(input.passphrase)
  } else if (input.kind === 'recovery') {
    requireBytes(input.recoveryKey, 32, 'The recovery key')
  } else if (input.kind === 'passkey') {
    requireBytes(input.prfOutput, 32, 'The PRF output')
    requireBytes(input.prfSalt, 32, 'The PRF salt')
    const credentialId = input.credentialId
    if (!(credentialId instanceof Uint8Array) || credentialId.length < 16 || credentialId.length > 1023) {
      throw new InvalidInputError('The credential id must be 16 to 1023 bytes')
    }
    if (typeof input.rpId !== 'string' || !RP_ID.test(input.rpId)) {
      throw new InvalidInputError('The rpId must be 1 to 253 of [a-z0-9.-]')
    }
  } else {
    throw new InvalidInputError('Unknown keyslot kind')
  }

  const vaultId = input.vaultId
  let ikm: Bytes | null = null
  try {
    // Section 6.6: slotId, then the salt (passphrase only), then the wrap IV.
    const slotId = rng.bytes(16)
    requireBytes(slotId, 16, 'The slot id the RNG returned')
    const vault = base32Encode(vaultId)
    const slot = base32Encode(slotId)
    let draft: Keyslot
    const placeholder = { commit: '', wrap: { iv: '', ct: '' }, mkCheck: '' }
    const common = { format: FORMAT, type: 'keyslot', vault, slot } as const
    if (input.kind === 'passphrase') {
      const salt = rng.bytes(16)
      requireBytes(salt, 16, 'The salt the RNG returned')
      const kdf: PassphraseKdf = {
        alg: 'argon2id',
        v: 19,
        m: params.m,
        t: params.t,
        p: params.p,
        salt: base64urlEncode(salt),
        secretKey: input.secretKey !== null,
      }
      draft = { ...common, kind: 'passphrase', kdf, ...placeholder }
      ikm = await passphraseIkm(password ?? new Uint8Array(), params, salt, input.secretKey, argon2)
    } else if (input.kind === 'recovery') {
      draft = { ...common, kind: 'recovery', kdf: { alg: 'recovery' }, ...placeholder }
      ikm = concat(input.recoveryKey)
    } else {
      const kdf: PasskeyKdf = {
        alg: 'prf',
        credentialId: base64urlEncode(input.credentialId),
        rpId: input.rpId,
        prfSalt: base64urlEncode(input.prfSalt),
      }
      draft = { ...common, kind: 'passkey', kdf, ...placeholder }
      ikm = concat(input.prfOutput)
    }
    const iv = rng.bytes(12)
    requireBytes(iv, 12, 'The IV the RNG returned')

    const keys = await slotKeys(ikm, vaultId, slotId, input.kind)
    const ct = await aesGcmEncrypt(keys.wrapKey, iv, input.mk, keyslotAad(draft))
    const mkCheck = await mkCheckOf(input.mk, vaultId)
    return {
      ...draft,
      commit: base64urlEncode(keys.commit),
      wrap: { iv: base64urlEncode(iv), ct: base64urlEncode(ct) },
      mkCheck: base64urlEncode(mkCheck),
    }
  } finally {
    zero(password, ikm)
  }
}

export async function openKeyslot(
  slot: Keyslot,
  secret: SlotSecret,
  options: { readonly vaultId: Uint8Array; readonly argon2?: Argon2Fn },
): Promise<Bytes> {
  // Steps 1 and 2: a hand-built object goes through the same checks as a parsed file, before anything costly.
  const checked = validate(slot)
  const { vaultId } = options
  requireBytes(vaultId, 16, 'The vault id')
  // Step 4.
  if (checked.vault !== base32Encode(vaultId)) throw new CorruptError('This keyslot belongs to another vault')

  // Step 5: the input key material; Argon2 runs here and only here.
  if (secret.kind !== checked.kind) throw new InvalidInputError(`This slot opens with a ${checked.kind} secret`)
  const slotId = base32Decode(checked.slot)
  let ikm: Bytes | null = null
  let mk: Bytes | null = null
  try {
    if (checked.kind === 'passphrase' && secret.kind === 'passphrase') {
      const { kdf } = checked
      if (kdf.secretKey) {
        if (secret.secretKey === null) throw new InvalidInputError('This slot needs the Secret Key')
        requireBytes(secret.secretKey, 16, 'The Secret Key')
      }
      const password = normalizePassphrase(secret.passphrase)
      try {
        const salt = base64urlDecode(kdf.salt)
        ikm = await passphraseIkm(
          password,
          kdf,
          salt,
          kdf.secretKey ? secret.secretKey : null,
          options.argon2 ?? defaultArgon2,
        )
      } finally {
        zero(password)
      }
    } else if (secret.kind === 'recovery') {
      requireBytes(secret.recoveryKey, 32, 'The recovery key')
      ikm = concat(secret.recoveryKey)
    } else if (secret.kind === 'passkey') {
      requireBytes(secret.prfOutput, 32, 'The PRF output')
      ikm = concat(secret.prfOutput)
    }
    if (!ikm) throw new InvalidInputError('Unknown secret kind')

    // Step 6: the commitment, compared in constant time, before AES-GCM ever runs.
    const keys = await slotKeys(ikm, vaultId, slotId, checked.kind)
    if (!equal(keys.commit, base64urlDecode(checked.commit))) throw new WrongSecretError()

    // Step 7.
    mk = await aesGcmDecrypt(
      keys.wrapKey,
      base64urlDecode(checked.wrap.iv),
      base64urlDecode(checked.wrap.ct),
      keyslotAad(checked),
    )
    if (mk.length !== 32) throw new TamperedError('The wrapped master key is not 32 bytes')

    // Step 8: the unwrapped key must be this vault's, compared in constant time.
    if (!equal(await mkCheckOf(mk, vaultId), base64urlDecode(checked.mkCheck))) {
      throw new TamperedError('The master key check does not match')
    }
    const result = mk
    mk = null
    return result
  } finally {
    zero(ikm, mk)
  }
}
