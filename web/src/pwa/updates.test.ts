import { expect, test } from 'bun:test'
import { createUpdateMachine } from './updates.ts'

/** A machine bound to a recording driver. */
function setup() {
  const m = createUpdateMachine()
  const calls: string[] = []
  m.bind({ skipWaiting: () => calls.push('skipWaiting'), reload: () => calls.push('reload') })
  return { m, calls }
}

/** Lets every pending promise continuation run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('starts with nothing waiting, not offline-ready, not active', () => {
  const { m } = setup()
  expect(m.updates.snapshot()).toEqual({ needRefresh: false, offlineReady: false, active: false })
})

test('a waiting worker sets needRefresh and notifies; the snapshot is stable between changes', () => {
  const { m } = setup()
  let notified = 0
  const unsubscribe = m.updates.subscribe(() => notified++)
  const before = m.updates.snapshot()
  expect(m.updates.snapshot()).toBe(before)
  m.events.waiting()
  expect(m.updates.snapshot().needRefresh).toBe(true)
  expect(m.updates.snapshot()).not.toBe(before)
  expect(notified).toBe(1)
  const after = m.updates.snapshot()
  m.events.waiting()
  expect(m.updates.snapshot()).toBe(after)
  expect(notified).toBe(1)
  unsubscribe()
  m.events.offlineReady()
  expect(notified).toBe(1)
  expect(m.updates.snapshot().offlineReady).toBe(true)
})

test('apply with nothing waiting does nothing', async () => {
  const { m, calls } = setup()
  await m.updates.apply()
  expect(calls).toEqual([])
})

test('apply before the worker is registered does nothing', async () => {
  const m = createUpdateMachine()
  m.events.waiting()
  await m.updates.apply()
  expect(m.updates.snapshot().needRefresh).toBe(true)
})

test('apply without holds: skip waiting, then reload once the new worker controls the page', async () => {
  const { m, calls } = setup()
  m.events.waiting()
  const applied = m.updates.apply()
  await settle()
  expect(calls).toEqual(['skipWaiting'])
  m.events.controlling(true)
  await applied
  expect(calls).toEqual(['skipWaiting', 'reload'])
  expect(m.updates.snapshot().active).toBe(true)
})

test('a hold delays activation itself until it is released', async () => {
  const { m, calls } = setup()
  m.events.waiting()
  const release = m.holdReload('stream')
  expect(m.holds()).toEqual(['stream'])
  void m.updates.apply()
  await settle()
  expect(calls).toEqual([])
  release()
  await settle()
  expect(calls).toEqual(['skipWaiting'])
  m.events.controlling(true)
  await settle()
  expect(calls).toEqual(['skipWaiting', 'reload'])
})

test('every hold must be released, in any order, and releasing twice is harmless', async () => {
  const { m, calls } = setup()
  m.events.waiting()
  const a = m.holdReload('stream')
  const b = m.holdReload('write')
  void m.updates.apply()
  a()
  a()
  await settle()
  expect(calls).toEqual([])
  expect(m.holds()).toEqual(['write'])
  b()
  await settle()
  expect(calls).toEqual(['skipWaiting'])
  expect(m.holds()).toEqual([])
})

test('a hold taken while the worker activates delays the reload', async () => {
  const { m, calls } = setup()
  m.events.waiting()
  void m.updates.apply()
  await settle()
  expect(calls).toEqual(['skipWaiting'])
  const release = m.holdReload('stream')
  m.events.controlling(true)
  await settle()
  expect(calls).toEqual(['skipWaiting'])
  release()
  await settle()
  expect(calls).toEqual(['skipWaiting', 'reload'])
})

test('concurrent applies share one run', async () => {
  const { m, calls } = setup()
  m.events.waiting()
  const first = m.updates.apply()
  const second = m.updates.apply()
  expect(second).toBe(first)
  await settle()
  m.events.controlling(true)
  await Promise.all([first, second])
  expect(calls).toEqual(['skipWaiting', 'reload'])
})

test('a newer worker replacing the one being activated is asked to activate too', async () => {
  const { m, calls } = setup()
  m.events.waiting()
  void m.updates.apply()
  await settle()
  m.events.waiting()
  expect(calls).toEqual(['skipWaiting', 'skipWaiting'])
  m.events.controlling(true)
  await settle()
  expect(calls).toEqual(['skipWaiting', 'skipWaiting', 'reload'])
})

test('an update activated by another tab is offered, and applying it only reloads', async () => {
  const { m, calls } = setup()
  m.events.controlling(true)
  expect(m.updates.snapshot()).toEqual({ needRefresh: true, offlineReady: false, active: true })
  const release = m.holdReload('stream')
  const applied = m.updates.apply()
  await settle()
  expect(calls).toEqual([])
  release()
  await applied
  expect(calls).toEqual(['reload'])
})

test('the first install claiming the page marks it active, with nothing to apply', async () => {
  const { m, calls } = setup()
  m.events.offlineReady()
  m.events.controlling(false)
  expect(m.updates.snapshot()).toEqual({ needRefresh: false, offlineReady: true, active: true })
  await m.updates.apply()
  expect(calls).toEqual([])
})

test('a page already controlled at registration is active', () => {
  const { m } = setup()
  m.events.active()
  expect(m.updates.snapshot().active).toBe(true)
})
