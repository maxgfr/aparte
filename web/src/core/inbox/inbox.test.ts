/*
 * The share inbox of spec/FORMAT.md section 16. X25519 is pinned to RFC 7748 section 6.1; a sealed item is opened here
 * by hand, with the key and associated data the spec defines, so the byte layout does not rest on openItem alone;
 * then every step of section 16.5 must fail with its error, and the key file and payload parsers must refuse anything
 * but their canonical form.
 */
import { describe, expect, test } from 'bun:test'
import {
  type AparteError,
  type BytesModule,
  CorruptError,
  InvalidInputError,
  type KeysModule,
  type RngModule,
  TamperedError,
  UnsupportedFormatError,
} from '../contracts/crypto.ts'
import type { InboxModule, InboxStoreModule, SharedContent } from '../contracts/inbox.ts'
import * as bytesImpl from '../crypto/bytes.ts'
import * as keysImpl from '../crypto/keys.ts'
import { paddedSize } from '../crypto/padme.ts'
import * as rngImpl from '../crypto/rng.ts'
import * as inboxImpl from './inbox.ts'
import { receiveShare, shareContent } from './receive.ts'
import { ensureInboxKey, openInboxSession } from './session.ts'
import * as storeImpl from './store.ts'

const B: BytesModule = bytesImpl
const K: KeysModule = keysImpl
const R: RngModule = rngImpl
const I: InboxModule = inboxImpl
const S: InboxStoreModule = storeImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
  otherVaultId: string
}
const vaultId = B.fromHex(inputs.vaultId)
const subkeys = await K.deriveSubkeys(B.fromHex(inputs.mk), vaultId)
const otherSubkeys = await K.deriveSubkeys(B.fromHex(inputs.mk), B.fromHex(inputs.otherVaultId))
const wrapKey = await K.localKey(subkeys, inboxImpl.INBOX_WRAP_NAME)

// RFC 7748 section 6.1: Alice's and Bob's scalars and public keys, and their shared secret.
const ALICE = B.fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')
const ALICE_PUBLIC = B.fromHex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a')
const BOB = B.fromHex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb')
const BOB_PUBLIC = B.fromHex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f')
const SHARED = B.fromHex('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742')
const WRAP_IV = new Uint8Array(12).fill(0x44)
const ITEM_IV = new Uint8Array(12).fill(0x55)

const CANARY = 'canary-share-91c2-the-shared-text-never-rests-in-clear'

async function alice() {
  return I.createInboxKey({ vaultId, wrapKey, rng: R.queueRng([ALICE, WRAP_IV]) })
}

const content: SharedContent = {
  header: {
    v: 1,
    time: 1760000000000,
    title: 'A title',
    text: CANARY,
    url: 'https://example.org/page',
    files: [
      { name: 'one.jpg', type: 'image/jpeg', size: 3 },
      { name: 'two.png', type: 'image/png', size: 2 },
    ],
  },
  files: [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])],
}

async function rejects(promise: Promise<unknown>, error: new (...args: never[]) => AparteError): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(error)
}

describe('inbox key', () => {
  test('the public key is the RFC 7748 one of the drawn scalar, and the file is canonical', async () => {
    const { file, pair } = await alice()
    expect(B.toHex(pair.publicKey)).toBe(B.toHex(ALICE_PUBLIC))
    expect(pair.privateKey.extractable).toBe(false)
    const parsed = I.parseInboxKey(file)
    expect(parsed.vault).toBe(B.base32Encode(vaultId))
    expect(parsed.key).toBe(B.base64urlEncode(ALICE_PUBLIC))
    expect(parsed.wrap.iv).toBe(B.base64urlEncode(WRAP_IV))
    // spec/FORMAT.md section 16.7.
    expect(parsed.wrap.ct).toBe('R7T3MM8upZZPaZjiaOMJLqs16tPx9nFdVn-n8OPjL5X-bbeZegvZNx6CdyBgI8LX')
    expect(file.length).toBe(235)
    expect(B.toHex(await K.sha256(file))).toBe('3e8de08e8f80e338c10fa9dcd3fb5d9ee163c4bf6324288fb722e5f005643cb8')
    expect(B.fromUtf8(file)).toBe(`${B.fromUtf8(I.serializeInboxKey(parsed)).trimEnd()}\n`)
    expect(B.fromUtf8(file).startsWith('{"format":"aparte/1","type":"inbox-key","vault":')).toBe(true)
  })

  test('the wrap is AES-GCM under K_local("inbox-key") with the spec AAD', async () => {
    const { file } = await alice()
    const parsed = I.parseInboxKey(file)
    const aad = B.utf8(`aparte/1|inbox-key|${parsed.vault}|${parsed.key}`)
    const scalar = await K.aesGcmDecrypt(wrapKey, WRAP_IV, B.base64urlDecode(parsed.wrap.ct), aad)
    expect(B.toHex(scalar)).toBe(B.toHex(ALICE))
  })

  test('unwraps to a key that agrees with RFC 7748', async () => {
    const { file } = await alice()
    const pair = await I.unwrapInboxKey(I.parseInboxKey(file), { vaultId, wrapKey })
    const bob = await crypto.subtle.importKey('raw', ALICE_PUBLIC, { name: 'X25519' }, true, [])
    const bobPrivate = await crypto.subtle.importKey(
      'pkcs8',
      B.concat(B.fromHex('302e020100300506032b656e04220420'), BOB),
      { name: 'X25519' },
      false,
      ['deriveBits'],
    )
    const fromBob = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: bob }, bobPrivate, 256))
    const peer = await crypto.subtle.importKey('raw', BOB_PUBLIC, { name: 'X25519' }, true, [])
    const fromAlice = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, pair.privateKey, 256),
    )
    expect(B.toHex(fromAlice)).toBe(B.toHex(SHARED))
    expect(B.toHex(fromBob)).toBe(B.toHex(SHARED))
  })

  test('refuses another vault, a wrong wrap key, a planted public key and a damaged wrap', async () => {
    const { file } = await alice()
    const parsed = I.parseInboxKey(file)
    await rejects(I.unwrapInboxKey(parsed, { vaultId: otherSubkeys.vaultId, wrapKey }), CorruptError)
    const otherWrap = await K.localKey(otherSubkeys, inboxImpl.INBOX_WRAP_NAME)
    await rejects(I.unwrapInboxKey(parsed, { vaultId, wrapKey: otherWrap }), TamperedError)
    // A page of the shared origin rewrites the public key to one it holds: the AAD no longer matches.
    await rejects(
      I.unwrapInboxKey({ ...parsed, key: B.base64urlEncode(BOB_PUBLIC) }, { vaultId, wrapKey }),
      TamperedError,
    )
    const ct = B.base64urlDecode(parsed.wrap.ct)
    ct[0] = (ct[0] ?? 0) ^ 1
    await rejects(
      I.unwrapInboxKey({ ...parsed, wrap: { ...parsed.wrap, ct: B.base64urlEncode(ct) } }, { vaultId, wrapKey }),
      TamperedError,
    )
  })

  test('parses the canonical form only', async () => {
    const { file } = await alice()
    const text = B.fromUtf8(file)
    const bad = [
      text.replace('{"format"', '{ "format"'),
      text.trimEnd(),
      text.replace('"type":"inbox-key",', '').replace('"key":', '"type":"inbox-key","key":'),
      text.replace('"wrap":', '"extra":1,"wrap":'),
      text.replace(/"key":"[^"]+"/, '"key":"AAAA"'),
      text.replace(/"vault":"[^"]+"/, '"vault":"6DY7F47U6X3PP6HZ7L57Z7P674"'),
      'not json',
    ]
    for (const t of bad) expect(() => I.parseInboxKey(B.utf8(t))).toThrow(CorruptError)
    expect(() => I.parseInboxKey(B.utf8(text.replace('aparte/1', 'aparte/2')))).toThrow(UnsupportedFormatError)
    const reordered = JSON.stringify({ type: 'inbox-key', ...JSON.parse(text) })
    expect(() => I.parseInboxKey(B.utf8(`${reordered}\n`))).toThrow(CorruptError)
  })
})

describe('share payload', () => {
  test('round-trips, with the header in writer order', () => {
    const payload = I.encodeShare(content)
    const hlen = B.readU32be(payload, 0)
    expect(B.fromUtf8(payload.subarray(4, 4 + hlen))).toBe(
      '{"v":1,"time":1760000000000,"title":"A title","text":"canary-share-91c2-the-shared-text-never-rests-in-clear","url":"https://example.org/page","files":[{"name":"one.jpg","type":"image/jpeg","size":3},{"name":"two.png","type":"image/png","size":2}]}',
    )
    expect([...payload.subarray(4 + hlen)]).toEqual([1, 2, 3, 4, 5])
    const back = I.decodeShare(payload)
    expect(back.header).toEqual(content.header)
    expect(back.files.map((f) => [...f])).toEqual([
      [1, 2, 3],
      [4, 5],
    ])
  })

  test('refuses what the format does not allow', () => {
    const header = content.header
    const refused: SharedContent[] = [
      { header: { ...header, title: '' }, files: content.files },
      { header: { ...header, text: '\ud800' }, files: content.files },
      { header: { ...header, time: -1 }, files: content.files },
      {
        header: { ...header, files: [{ name: 'x', type: 'Image/JPEG', size: 3 }, header.files[1] as never] },
        files: content.files,
      },
      {
        header: { ...header, files: [{ name: '', type: 'image/jpeg', size: 3 }, header.files[1] as never] },
        files: content.files,
      },
      { header, files: [Uint8Array.from([1, 2]), Uint8Array.from([4, 5])] },
      { header, files: [Uint8Array.from([1, 2, 3])] },
    ]
    for (const c of refused) expect(() => I.encodeShare(c)).toThrow(InvalidInputError)
  })

  test('decodes the canonical form only', () => {
    const json = (s: string) => {
      const h = B.utf8(s)
      return B.concat(B.u32be(h.length), h)
    }
    const bad = [
      json('{"time":1,"v":1,"files":[]}'),
      json('{"v":1,"time":1,"files":[] }'),
      json('{"v":1,"time":1,"files":[],"extra":true}'),
      json('{"v":1,"time":1,"text":"\\ud800","files":[]}'),
      json('{"v":2,"time":1,"files":[]}'),
      B.concat(json('{"v":1,"time":1,"files":[{"name":"a","type":"text/plain","size":2}]}'), Uint8Array.from([1])),
      B.concat(json('{"v":1,"time":1,"files":[]}'), Uint8Array.from([1])),
      B.concat(B.u32be(10), B.utf8('{}')),
      Uint8Array.from([0, 0]),
    ]
    for (const p of bad) expect(() => I.decodeShare(p)).toThrow(CorruptError)
    expect(I.decodeShare(json('{"v":1,"time":1,"files":[]}')).header).toEqual({ v: 1, time: 1, files: [] })
  })
})

describe('sealed item', () => {
  async function sealed() {
    const { file, pair } = await alice()
    const recipient = I.recipientOf(I.parseInboxKey(file))
    const payload = I.encodeShare(content)
    const bytes = await I.sealItem(recipient, payload, R.queueRng([BOB, ITEM_IV]))
    return { pair, payload, bytes }
  }

  test('has the layout of section 16.5, and opens by hand with the spec key and AAD', async () => {
    const { payload, bytes } = await sealed()
    expect(B.toHex(bytes.subarray(0, 8))).toBe('4150583101000000')
    expect(B.toHex(bytes.subarray(8, 40))).toBe(B.toHex(BOB_PUBLIC))
    expect(B.toHex(bytes.subarray(40, 52))).toBe(B.toHex(ITEM_IV))
    expect(bytes.length).toBe(52 + paddedSize(payload.length) + 16)
    const raw = await K.hkdfSha256(SHARED, B.concat(vaultId, BOB_PUBLIC, ALICE_PUBLIC), B.utf8('aparte/1/inbox'))
    const aad = B.concat(bytes.subarray(0, 52), vaultId, ALICE_PUBLIC)
    const plaintext = await K.aesGcmDecrypt(raw, ITEM_IV, bytes.subarray(52), aad)
    expect(B.readU32be(plaintext, 0)).toBe(payload.length)
    expect(B.toHex(plaintext.subarray(4, 4 + payload.length))).toBe(B.toHex(payload))
    expect(plaintext.subarray(4 + payload.length).every((b) => b === 0)).toBe(true)
  })

  test('is deterministic under a queued RNG (a worked example both sides could pin)', async () => {
    const a = await sealed()
    const b = await sealed()
    expect(B.toHex(a.bytes)).toBe(B.toHex(b.bytes))
    // spec/FORMAT.md section 16.7: the worked example's 257-byte payload seals to 340 bytes with this digest.
    expect(a.payload.length).toBe(257)
    expect(a.bytes.length).toBe(340)
    expect(B.toHex(await K.sha256(a.bytes))).toBe('6c02d2952f6a560031a1708b68b7bbb36a3eda81d507363404cd78e54d9202fd')
  })

  test('opens to the payload, and never carries the plaintext', async () => {
    const { pair, payload, bytes } = await sealed()
    expect(B.toHex(await I.openItem(pair, bytes))).toBe(B.toHex(payload))
    expect(Buffer.from(bytes).toString('latin1').includes(CANARY)).toBe(false)
  })

  test('every step of section 16.5 fails with its error', async () => {
    const { pair, bytes } = await sealed()
    /** The sealed item with byte `at` set to `value` (or flipped with `xor`). */
    const set = (at: number, value: number) => {
      const copy = new Uint8Array(bytes)
      copy[at] = value
      return copy
    }
    const flip = (at: number) => set(at, (bytes[at] ?? 0) ^ 1)
    const zeroKey = new Uint8Array(bytes)
    zeroKey.fill(0, 8, 40)
    await rejects(I.openItem(pair, bytes.subarray(0, 131)), CorruptError)
    await rejects(I.openItem(pair, set(0, 0x42)), CorruptError)
    await rejects(I.openItem(pair, set(4, 2)), UnsupportedFormatError)
    await rejects(I.openItem(pair, set(6, 1)), CorruptError)
    // A low-order point as the ephemeral key: the shared secret would be zero.
    await rejects(I.openItem(pair, zeroKey), CorruptError)
    await rejects(I.openItem(pair, flip(45)), TamperedError)
    await rejects(I.openItem(pair, flip(bytes.length - 1)), TamperedError)
    await rejects(I.openItem(pair, bytes.subarray(0, bytes.length - 1)), TamperedError)
    const other = await I.createInboxKey({ vaultId, wrapKey, rng: R.cryptoRng() })
    await rejects(I.openItem(other.pair, bytes), TamperedError)
  })
})

let dbCount = 0
const dbName = () => `inbox-test-${++dbCount}-${crypto.randomUUID()}`

describe('inbox database', () => {
  test('the service worker never creates it', async () => {
    const name = dbName()
    expect(await S.openInboxStore({ name, create: false })).toBeNull()
    const names = (await indexedDB.databases()).map((d) => d.name)
    expect(names).not.toContain(name)
  })

  test('holds the key file and sealed items, at most MAX_ITEMS of them', async () => {
    const name = dbName()
    const store = await S.openInboxStore({ name })
    if (store === null) throw new Error('not opened')
    expect(await store.keyFile()).toBeNull()
    const { file } = await alice()
    await store.putKeyFile(file)
    expect(B.toHex((await store.keyFile()) ?? new Uint8Array())).toBe(B.toHex(file))
    const worker = await S.openInboxStore({ name, create: false })
    expect(worker).not.toBeNull()
    const sealed = await I.sealItem(I.recipientOf(I.parseInboxKey(file)), I.encodeShare(content), R.cryptoRng())
    const rng = R.seededRng(7)
    for (let i = 0; i < I.MAX_ITEMS; i++) await store.addItem({ id: inboxImpl.newItemId(rng), bytes: sealed })
    expect(await store.count()).toBe(I.MAX_ITEMS)
    await rejects(
      store.addItem({ id: inboxImpl.newItemId(rng), bytes: sealed }),
      (await import('../contracts/crypto.ts')).InvalidStateError,
    )
    expect(await store.count()).toBe(I.MAX_ITEMS)
    await rejects(store.addItem({ id: 'not-an-id', bytes: sealed }), InvalidInputError)
    const items = await store.items()
    expect(items).toHaveLength(I.MAX_ITEMS)
    await store.deleteItem(items[0]?.id ?? '')
    expect(await store.count()).toBe(I.MAX_ITEMS - 1)
    store.close()
    worker?.close()
  })
})

/** A FormData stand-in with the share target's fields. */
function form(fields: Record<string, unknown>, files: File[] = []) {
  return {
    get: (name: string) => fields[name] ?? null,
    getAll: (name: string) => (name === 'files' ? files : fields[name] === undefined ? [] : [fields[name]]),
  }
}

describe('receiving a share', () => {
  test('seals it to the inbox key, and the page opens it after unlock', async () => {
    const name = dbName()
    const page = await S.openInboxStore({ name })
    if (page === null) throw new Error('not opened')
    const session = await openInboxSession({ store: page, subkeys, rng: R.cryptoRng() })
    const sw = await S.openInboxStore({ name, create: false })
    const photo = new File([Uint8Array.from([9, 8, 7])], 'photo\u0000/../.jpg', { type: 'image/JPEG' })
    const outcome = await receiveShare({
      store: sw,
      form: form({ title: '  Hello  ', text: CANARY, url: '' }, [photo]),
      rng: R.cryptoRng(),
      now: 1760000000000,
    })
    expect(outcome).toBe('stored')
    const raw = await sw?.items()
    expect(
      Buffer.from(raw?.[0]?.bytes ?? [])
        .toString('latin1')
        .includes(CANARY),
    ).toBe(false)
    const { shares, lost } = await session.read()
    expect(lost).toBe(0)
    expect(shares).toHaveLength(1)
    expect(shares[0]?.content.header).toEqual({
      v: 1,
      time: 1760000000000,
      title: 'Hello',
      text: CANARY,
      files: [{ name: 'photo...jpg', type: 'image/jpeg', size: 3 }],
    })
    expect([...(shares[0]?.content.files[0] ?? [])]).toEqual([9, 8, 7])
    await session.remove(shares[0]?.id ?? '')
    expect(await page.count()).toBe(0)
    page.close()
    sw?.close()
  })

  test('says why a share was not kept', async () => {
    const rng = R.cryptoRng()
    const now = 1
    expect(await receiveShare({ store: null, form: form({ text: 'x' }), rng, now })).toBe('no-key')
    const name = dbName()
    const store = await S.openInboxStore({ name })
    expect(await receiveShare({ store, form: form({ text: 'x' }), rng, now })).toBe('no-key')
    if (store === null) throw new Error('not opened')
    await ensureInboxKey(store, subkeys, rng)
    expect(await receiveShare({ store, form: form({ text: '   ' }), rng, now })).toBe('empty')
    const many = Array.from(
      { length: 17 },
      (_, i) => new File([Uint8Array.from([i])], `${i}.jpg`, { type: 'image/jpeg' }),
    )
    expect(await receiveShare({ store, form: form({}, many), rng, now })).toBe('too-large')
    for (let i = 0; i < I.MAX_ITEMS; i++)
      expect(await receiveShare({ store, form: form({ text: `${i}` }), rng, now })).toBe('stored')
    expect(await receiveShare({ store, form: form({ text: 'one more' }), rng, now })).toBe('full')
    store.close()
  })

  test('shareContent drops empty files and fields', async () => {
    const empty = new File([], 'empty.jpg', { type: 'image/jpeg' })
    expect(await shareContent(form({ title: '' }, [empty]), 5)).toBeNull()
  })
})

describe('inbox session', () => {
  test('keeps its key across unlocks, and replaces one it cannot open', async () => {
    const name = dbName()
    const store = await S.openInboxStore({ name })
    if (store === null) throw new Error('not opened')
    const first = await ensureInboxKey(store, subkeys, R.cryptoRng())
    const again = await ensureInboxKey(store, subkeys, R.cryptoRng())
    expect(B.toHex(again.publicKey)).toBe(B.toHex(first.publicKey))
    // A share sealed to the current key, then the file is replaced by one of another vault (a new vault here).
    expect(await receiveShare({ store, form: form({ text: 'old' }), rng: R.cryptoRng(), now: 1 })).toBe('stored')
    const other = await openInboxSession({ store, subkeys: otherSubkeys, rng: R.cryptoRng() })
    const read = await other.read()
    expect(read).toEqual({ shares: [], lost: 1 })
    expect(await store.count()).toBe(0)
    const replaced = await ensureInboxKey(store, subkeys, R.cryptoRng())
    expect(B.toHex(replaced.publicKey)).not.toBe(B.toHex(first.publicKey))
    other.dispose()
    await expect(other.read()).rejects.toThrow()
    store.close()
  })
})
