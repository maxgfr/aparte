/*
 * The vector generator: its output is deterministic, laid out as spec/vectors/README.md states, agrees with the
 * worked examples of spec/FORMAT.md section 15, and equals the committed spec/vectors files, so a change to the crypto
 * modules that moves a byte fails here until the vectors are regenerated (and the Rust side follows).
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { BytesModule } from '../src/core/contracts/crypto.ts'
import * as bytesImpl from '../src/core/crypto/bytes.ts'
import { computeVectors, readInputs, serializeVectors, VECTOR_FILES, VECTORS_DIR } from './vectors.ts'

const B: BytesModule = bytesImpl

const inputs = await readInputs()
const vectors = await computeVectors(inputs)
const files = serializeVectors(vectors)

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')
const hexOf = (s: string) => Buffer.from(s, 'utf8').toString('hex')
const byId = <T extends { id: string }>(cases: readonly T[], id: string): T => {
  const found = cases.find((c) => c.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return found
}

const { keyslots, malicious, texts, secretKeyText, recoveryKeyText } = vectors['keyslots.json']
const { envelopes, tamper } = vectors['envelopes.json']
const names = vectors['names.json']
const framing = vectors['framing.json']

describe('layout', () => {
  test('every file of the README table, in its order', () => {
    expect(Object.keys(files)).toEqual([
      'keys.json',
      'keyslots.json',
      'envelopes.json',
      'names.json',
      'padme.json',
      'framing.json',
      'text.json',
    ])
  })

  test.each(VECTOR_FILES)('%s is 2-space JSON with a final line feed and no null', (file) => {
    const content = files[file]
    expect(content.endsWith('}\n')).toBe(true)
    expect(content.endsWith('\n\n')).toBe(false)
    expect(`${JSON.stringify(JSON.parse(content), null, 2)}\n`).toBe(content)
    expect(content).not.toMatch(/: null\b/)
  })

  test('byte strings are written as lowercase hex', () => {
    const parsed = JSON.parse(files['envelopes.json']) as { envelopes: Record<string, string>[] }
    const first = parsed.envelopes[0] ?? {}
    for (const member of ['header', 'aad', 'plaintext', 'sealed', 'payload']) {
      expect(first[member]).toMatch(/^(?:[0-9a-f]{2})*$/)
    }
    expect(first.sealed).toBe(hex(envelopes[0]?.sealed ?? new Uint8Array()))
  })
})

describe('reproducibility', () => {
  test('a second run gives the same bytes', async () => {
    expect(serializeVectors(await computeVectors(inputs))).toEqual(files)
  })

  test.each(VECTOR_FILES)('the committed spec/vectors/%s is the current output', async (file) => {
    const committed = Bun.file(resolve(VECTORS_DIR, file))
    expect(await committed.exists()).toBe(true)
    expect(await committed.text()).toBe(files[file])
  })
})

describe('spec/FORMAT.md section 15', () => {
  const slot = byId(keyslots, 'passphrase-secret-key')

  test('15.1 encodings', () => {
    expect(vectors['keys.json'].vault).toBe('6dy7f47u6x3pp6hz7l57z7p674')
    expect(slot.name).toBe('keys/ceirceirceirceirceirceirce.json')
    const file = JSON.parse(text(slot.file)) as { kdf: { salt: string }; wrap: { iv: string } }
    expect(file.kdf.salt).toBe('IiIiIiIiIiIiIiIiIiIiIg')
    expect(file.wrap.iv).toBe('MzMzMzMzMzMzMzMz')
  })

  test('15.2 keyslot AAD and file order', () => {
    expect(text(slot.aad)).toBe(
      'aparte/1|keyslot|6dy7f47u6x3pp6hz7l57z7p674|ceirceirceirceirceirceirce|passphrase|' +
        '{"alg":"argon2id","m":19456,"p":1,"salt":"IiIiIiIiIiIiIiIiIiIiIg","secretKey":true,"t":2,"v":19}',
    )
    const file = text(slot.file)
    expect(file).toContain('"kdf":{"alg":"argon2id","v":19,"m":19456,"t":2,"p":1,"salt":"IiIiIiIiIiIiIiIiIiIiIg"')
    expect(file.endsWith('}\n')).toBe(true)
    expect(slot.argon2).toHaveLength(32)
    expect(slot.ikm).toHaveLength(48)
  })

  test('keyslot members per kind, and the key texts', () => {
    for (const s of keyslots) {
      expect('salt' in s).toBe(s.kind === 'passphrase')
      expect('argon2' in s).toBe(s.kind === 'passphrase')
      expect(s.wrapCt).toHaveLength(48)
      expect(s.commit).toHaveLength(32)
      expect(hex(s.mkCheck)).toBe(hex(vectors['keys.json'].mkCheck))
    }
    expect(byId(keyslots, 'passphrase-only').ikm).toHaveLength(32)
    expect(secretKeyText).toMatch(/^A1(-[A-Z2-7]{5}){6}$/)
    expect(recoveryKeyText).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/)
    expect(recoveryKeyText.replaceAll('-', '').toLowerCase()).toBe(B.base32Encode(B.fromHex(inputs.recoveryKey)))
  })

  test('every malicious keyslot is unsupported-keyslot, built as the README states', () => {
    expect(malicious.map((m) => m.id)).toEqual(inputs.maliciousKeyslots.cases.map((c) => c.id))
    for (const m of malicious) expect(m.error).toBe('unsupported-keyslot')
    expect(text(byId(malicious, 'm-fraction').file)).toContain('"m":65536.5,')
    expect(text(byId(malicious, 'm-huge').file)).toContain('"m":4294967296,')
    expect(text(byId(malicious, 'kdf-extra-member').file)).toContain('"secretKey":true,"lanes":')
    expect(text(byId(malicious, 'kdf-missing-t').file)).toContain('"m":19456,"p":1,')
    for (const m of malicious) expect(text(m.file).endsWith('}\n')).toBe(true)
  })

  test('every keyslot text case gets the error of FORMAT.md sections 3.5 and 6.7', () => {
    expect(texts.map((t) => t.id)).toEqual(inputs.keyslotTexts.cases.map((c) => c.id))
    const errors = Object.fromEntries(texts.map((t) => [t.id, t.error]))
    expect(errors).toEqual({
      'm-beyond-binary64': 'unsupported-keyslot',
      'm-integer-beyond-binary64': 'unsupported-keyslot',
      'kdf-extra-deep': 'unsupported-keyslot',
      'kdf-name-lone-surrogate': 'corrupt',
      'format-lone-high': 'corrupt',
      'format-two-highs': 'corrupt',
      'format-lone-in-replaced-duplicate': 'corrupt',
      'format-pair': 'unsupported-keyslot',
      'format-escaped-backslash': 'unsupported-keyslot',
      'kind-lone-high': 'corrupt',
      'alg-lone-low': 'corrupt',
      'type-beyond-binary64': 'corrupt',
      'extra-deep': 'corrupt',
    })
    expect(text(byId(texts, 'm-beyond-binary64').file)).toContain('"m":1e400,')
    expect(text(byId(texts, 'format-lone-high').file)).toContain('"format":"\\ud800",')
    for (const t of texts) expect(text(t.file).endsWith('}\n')).toBe(true)
  })

  test('15.3 envelope segment-plain', () => {
    const e = byId(envelopes, 'segment-plain')
    const c = byId(inputs.envelopes, 'segment-plain')
    expect(hex(e.header)).toBe('4150543101010000a0a1a2a3a4a5a6a7a8a9aaab')
    expect(hex(e.aad)).toBe(hex(e.header) + inputs.vaultId + hexOf(c.name))
    expect(hex(e.plaintext)).toBe(`0000003e${c.payload}${'00'.repeat(6)}`)
    expect(e.sealed).toHaveLength(108)
    expect(hex(e.sealed.subarray(0, 20))).toBe(hex(e.header))
  })

  test('15.3 padding edges and compressed cases', () => {
    expect(byId(envelopes, 'empty').sealed).toHaveLength(100)
    expect(byId(envelopes, 'boundary-60').sealed).toHaveLength(100)
    expect(byId(envelopes, 'boundary-61').sealed).toHaveLength(108)
    for (const id of ['segment-deflate', 'checkpoint-deflate']) {
      const c = byId(inputs.envelopes, id)
      const e = byId(envelopes, id)
      expect(e.header[6]).toBe(1)
      expect(hex(e.payload)).toBe(c.payload)
      expect(hex(e.plaintext.subarray(4, 4 + (c.deflated?.length ?? 0) / 2))).toBe(c.deflated ?? '')
    }
  })

  test('15.3 tamper errors are those of section 7.5', () => {
    expect(Object.fromEntries(tamper.map((t) => [t.id, t.error]))).toEqual({
      magic: 'corrupt',
      version: 'unsupported-format',
      'kind-unknown': 'corrupt',
      'kind-mismatch': 'corrupt',
      'flags-unknown': 'corrupt',
      'flags-compress': 'tampered',
      epoch: 'unsupported-format',
      iv: 'tampered',
      ciphertext: 'tampered',
      tag: 'tampered',
      'trailing-byte': 'tampered',
      'truncated-tag': 'tampered',
      'truncated-short': 'corrupt',
      'name-swap': 'tampered',
      'vault-swap': 'tampered',
      'padding-non-zero': 'corrupt',
      'length-beyond': 'corrupt',
      'padding-excess': 'corrupt',
      'deflate-garbage': 'corrupt',
    })
    expect(hex(byId(tamper, 'vault-swap').vaultId)).toBe(inputs.otherVaultId)
    expect(byId(tamper, 'name-swap').name).not.toBe(byId(tamper, 'magic').name)
    expect(byId(tamper, 'trailing-byte').bytes).toHaveLength(109)
    expect(byId(tamper, 'truncated-short').bytes).toHaveLength(99)
  })

  test('7.4 padme examples', () => {
    const table = new Map(vectors['padme.json'].padme.map((p) => [p.length, p.padme]))
    expect(table.get(65)).toBe(72)
    expect(table.get(100)).toBe(104)
    expect(table.get(1000)).toBe(1024)
    expect(table.get(1025)).toBe(1088)
    expect(table.get(2097156)).toBe(2162688)
    for (const p of vectors['padme.json'].padme) {
      expect(p.paddedSize).toBeGreaterThanOrEqual(Math.max(64, p.length + 4))
    }
  })
})

describe('names, framing and text', () => {
  test('names follow the grammar of section 8.8', () => {
    for (const d of names.devices) expect(d.dtag).toMatch(/^[a-z2-7]{16}$/)
    for (const d of names.docs) expect(d.stag).toMatch(/^[a-z2-7]{16}$/)
    for (const s of names.shards) expect(s.shard).toMatch(/^c(0\d|1[0-5])$/)
    for (const s of names.segments) {
      expect(s.name).toMatch(/^d\/[a-z2-7]{16}\/s\/[a-z2-7]{16}\/\d{7}\/\d{10}-[a-z2-7]{8}$/)
    }
    for (const s of names.checkpoints) expect(s.name).toMatch(/^d\/[a-z2-7]{16}\/c\/[a-z2-7]{16}\/\d{10}-[a-z2-7]{8}$/)
    for (const c of names.chunks) expect(c.name).toBe(`b/${c.id.slice(0, 2)}/${c.id}`)
    for (const m of names.manifests) expect(m.name).toBe(`m/${m.id.slice(0, 2)}/${m.id}`)
    for (const s of names.secrets) expect(s.name.startsWith(`k/${s.ktag}/0000000001-`)).toBe(true)
    for (const l of names.local) expect(l.name).toMatch(/^[a-z2-7]{26}$/)
    expect(names.segments.at(-1)?.name).toContain('/9999999/9999999999-')
  })

  test('the keys cover every envelope and local name', () => {
    const objectNames = vectors['keys.json'].objectKeys.map((k) => k.name)
    const localNames = vectors['keys.json'].localKeys.map((k) => k.name)
    for (const e of inputs.envelopes) expect(e.kind === 6 ? localNames : objectNames).toContain(e.name)
    for (const l of names.local) expect(localNames).toContain(l.name)
  })

  test('segment and checkpoint headers are in writer order with sorted maps and blobs', () => {
    const segment = text(framing.segment.header)
    expect(segment).toBe(
      '{"v":1,"doc":"c07","device":"aaaaaaaaaaaaaaaa","seq":3,"time":1760000000000,' +
        '"seen":{"aaaaaaaaaaaaaaab":4,"bbbbbbbbbbbbbbbb":12},' +
        '"blobs":["mmmmmmmmmmmmmmmmmmmmmmmmmm","zzzzzzzzzzzzzzzzzzzzzzzzzz"]}',
    )
    expect(hex(framing.segment.payload)).toBe(
      segment.length.toString(16).padStart(8, '0') + hexOf(segment) + inputs.framing.segment.update,
    )
    expect(text(framing.checkpoint.header)).toEndWith(
      ',"blobs":[],"covers":{"aaaaaaaaaaaaaaaa":7,"bbbbbbbbbbbbbbbb":12}}',
    )
  })

  test('the local record payload is u8 purpose, u16be id, value', () => {
    expect(hex(framing.local.payload)).toBe(
      `0b${hexOf('oauth-token')}001b${hexOf('mcp:https://mcp.example.org')}${inputs.framing.local.value}`,
    )
    const same = names.local.find((l) => l.purpose === framing.local.purpose && l.id === framing.local.id)
    expect(framing.local.name).toBe(same?.name ?? '')
  })

  test('text samples round trip and every invalid sample is invalid-input', () => {
    const t = vectors['text.json']
    expect(t.base32.map((s) => hex(s.hex))).toEqual(inputs.text.base32)
    expect(t.base64url.map((s) => hex(s.hex))).toEqual(inputs.text.base64url)
    expect(t.base32.at(-1)?.text).toHaveLength(52)
    for (const s of [...t.base32Invalid, ...t.base64urlInvalid]) expect(s.error).toBe('invalid-input')
  })
})
