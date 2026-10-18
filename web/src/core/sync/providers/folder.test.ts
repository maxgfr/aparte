import { describe, expect, test } from 'bun:test'
import { device } from '../testkit.ts'
import { folderStore, memoryDir } from './folder.ts'
import { MemoryBucket } from './memory.ts'
import { remoteContract } from './remote.contract.ts'

remoteContract('folder', async () => {
  const root = memoryDir('vault')
  return { store: folderStore(root), again: () => folderStore(root) }
})

describe('folder store', () => {
  test('objects are nested files; files the OS leaves there are not listed', async () => {
    const root = memoryDir('vault')
    const store = folderStore(root)
    await store.put('fmt/1', new TextEncoder().encode('aparte/1\n'))
    const fmt = await root.getDirectoryHandle('fmt')
    await (await (await fmt.getFileHandle('.DS_Store', { create: true })).createWritable()).close()
    await (await (await root.getFileHandle('x.crswap', { create: true })).createWritable()).close()
    expect((await store.list()).map((e) => e.name)).toEqual(['fmt/1'])
    expect(store.id).toBe('folder:vault')
  })

  test('a revoked permission is a needs-permission error until granted again', async () => {
    const permission: { state: PermissionState } = { state: 'prompt' }
    const store = folderStore(memoryDir('vault', permission))
    await expect(store.list()).rejects.toMatchObject({ kind: 'permission' })
    expect(await store.requestPermission()).toBe(true)
    expect(await store.list()).toEqual([])
  })

  test('two devices sync through one folder', async () => {
    const root = memoryDir('shared')
    const bucket = new MemoryBucket()
    const a = await device(bucket, { remote: () => folderStore(root) })
    const b = await device(bucket, { remote: () => folderStore(root) })
    const conv = a.ws.conversations.create({ title: 'via a folder' })
    await a.sync()
    await b.sync()
    expect(b.ws.conversations.get(conv)?.title).toBe('via a folder')
  })
})
