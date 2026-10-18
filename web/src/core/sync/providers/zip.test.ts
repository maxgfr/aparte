import { describe, expect, test } from 'bun:test'
import { CorruptError } from '../../contracts/crypto.ts'
import { concat, utf8 } from '../../crypto/bytes.ts'
import { deflateRaw } from '../../crypto/envelope.ts'
import { device } from '../testkit.ts'
import { MemoryBucket } from './memory.ts'
import { remoteContract } from './remote.contract.ts'
import { crc32, readZip, writeZip, ZIP_README, zipStore } from './zip.ts'

remoteContract('zip', async () => ({ store: zipStore() }))

describe('zip archives', () => {
  test('CRC-32 of the standard check string', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926)
  })

  test('write then read gives every entry back, and carries no timestamp', async () => {
    const entries = [
      { name: 'fmt/1', bytes: utf8('aparte/1\n') },
      { name: 'b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa', bytes: new Uint8Array(70_000).map((_, i) => i & 0xff) },
    ]
    const zip = writeZip(entries)
    const back = await readZip(zip)
    expect([...back.keys()]).toEqual(entries.map((e) => e.name))
    for (const e of entries) expect(back.get(e.name)).toEqual(e.bytes)
    // DOS time 0 and date 1980-01-01 in the first local header.
    expect([...zip.subarray(10, 14)]).toEqual([0, 0, 0x21, 0])
  })

  test('a deflated entry (an archive repacked by a zip tool) reads too', async () => {
    const content = utf8('aparte/1\n'.repeat(50))
    const deflated = await deflateRaw(content)
    const stored = writeZip([{ name: 'fmt/1', bytes: content }])
    // Rebuild the same archive with method 8 and the deflated bytes.
    const name = utf8('fmt/1')
    const header = new Uint8Array(30 + name.length)
    const hv = new DataView(header.buffer)
    hv.setUint32(0, 0x04034b50, true)
    hv.setUint16(8, 8, true)
    hv.setUint32(14, crc32(content), true)
    hv.setUint32(18, deflated.length, true)
    hv.setUint32(22, content.length, true)
    hv.setUint16(26, name.length, true)
    header.set(name, 30)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, 8, true)
    cv.setUint32(16, crc32(content), true)
    cv.setUint32(20, deflated.length, true)
    cv.setUint32(24, content.length, true)
    cv.setUint16(28, name.length, true)
    central.set(name, 46)
    const end = new Uint8Array(22)
    const ev = new DataView(end.buffer)
    ev.setUint32(0, 0x06054b50, true)
    ev.setUint16(8, 1, true)
    ev.setUint16(10, 1, true)
    ev.setUint32(12, central.length, true)
    ev.setUint32(16, header.length + deflated.length, true)
    const zip = concat(header, deflated, central, end)
    expect((await readZip(zip)).get('fmt/1')).toEqual(content)
    expect(stored.length).toBeGreaterThan(0)
  })

  test('a damaged entry or a non-zip is corrupt', async () => {
    const zip = writeZip([{ name: 'fmt/1', bytes: utf8('aparte/1\n') }])
    const damaged = new Uint8Array(zip)
    damaged[35] = (damaged[35] as number) ^ 1
    await expect(readZip(damaged)).rejects.toBeInstanceOf(CorruptError)
    await expect(readZip(utf8('not a zip at all, sorry'))).rejects.toBeInstanceOf(CorruptError)
  })

  test('export into an archive, then a new device imports it', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    const blob = await a.blobs.put(
      new Uint8Array(3_000_000).map((_, i) => (i * 7) & 0xff),
      'image/jpeg',
    )
    const conv = a.ws.conversations.create({ title: 'archived' })
    const archive = zipStore()
    a.engine.addDestination(archive, 'archive')
    await a.ws.flush()
    await a.engine.round(archive.id)
    const bytes = archive.toBytes()
    const entries = await readZip(bytes)
    expect(entries.has(ZIP_README)).toBe(true)
    expect(entries.has('fmt/1')).toBe(true)

    const b = await device(new MemoryBucket())
    const imported = zipStore(entries, 'import')
    b.engine.addDestination(imported, 'import')
    await b.engine.round(imported.id)
    expect(b.ws.conversations.get(conv)?.title).toBe('archived')
    expect((await b.blobs.get(blob))?.length).toBe(3_000_000)
  })
})
