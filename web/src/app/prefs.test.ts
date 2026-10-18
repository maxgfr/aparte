import { describe, expect, test } from 'bun:test'
import { type PrefStorage, readPref, subscribePrefs, writePref } from './prefs.ts'

function memory(): PrefStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

describe('prefs', () => {
  test('unset reads as the default', () => {
    expect(readPref('theme', memory())).toBe('system')
    expect(readPref('theme', null)).toBe('system')
  })

  test('round-trips a value under the namespaced key', () => {
    const s = memory()
    writePref('theme', 'dark', s)
    expect(s.data.get('aparte:theme')).toBe('dark')
    expect(readPref('theme', s)).toBe('dark')
  })

  test('the default is stored as its absence', () => {
    const s = memory()
    writePref('theme', 'light', s)
    writePref('theme', 'system', s)
    expect(s.data.size).toBe(0)
  })

  test('an invalid stored value falls back to the default', () => {
    const s = memory()
    s.data.set('aparte:theme', '<script>')
    expect(readPref('theme', s)).toBe('system')
  })

  test('voice and notification preferences: engines and flags, validated', () => {
    const s = memory()
    expect(readPref('dictation', s)).toBe('local')
    expect(readPref('pushToTalk', s)).toBe(false)
    expect(readPref('readAloud', s)).toBe('device')
    expect(readPref('notifyAnswers', s)).toBe(false)
    writePref('dictation', 'browser', s)
    writePref('pushToTalk', true, s)
    writePref('readAloud', 'api', s)
    writePref('notifyAnswers', true, s)
    expect([...s.data]).toEqual([
      ['aparte:dictation', 'browser'],
      ['aparte:push-to-talk', '1'],
      ['aparte:read-aloud', 'api'],
      ['aparte:notify-answers', '1'],
    ])
    expect(readPref('pushToTalk', s)).toBe(true)
    writePref('pushToTalk', false, s)
    expect(s.data.has('aparte:push-to-talk')).toBe(false)
    s.data.set('aparte:dictation', 'cloud')
    s.data.set('aparte:notify-answers', 'yes')
    expect(readPref('dictation', s)).toBe('local')
    expect(readPref('notifyAnswers', s)).toBe(false)
  })

  test('a storage that throws never breaks a read or a write', () => {
    const broken: PrefStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(readPref('theme', broken)).toBe('system')
    expect(() => writePref('theme', 'dark', broken)).not.toThrow()
  })

  test('writes notify subscribers until they unsubscribe', () => {
    let calls = 0
    const stop = subscribePrefs(() => calls++)
    writePref('theme', 'dark', memory())
    stop()
    writePref('theme', 'light', memory())
    expect(calls).toBe(1)
  })
})
