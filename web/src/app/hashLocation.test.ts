import { describe, expect, test } from 'bun:test'
import { hashFor, parseHash, sectionOf } from './hashLocation.ts'

describe('parseHash', () => {
  test('an empty or bare hash is the start screen', () => {
    expect(parseHash('')).toEqual({ path: '/', search: '' })
    expect(parseHash('#')).toEqual({ path: '/', search: '' })
    expect(parseHash('#/')).toEqual({ path: '/', search: '' })
  })

  test('path and query stay together inside the hash', () => {
    expect(parseHash('#/about')).toEqual({ path: '/about', search: '' })
    expect(parseHash('#/about?tab=build&x=1')).toEqual({ path: '/about', search: 'tab=build&x=1' })
    expect(parseHash('#about')).toEqual({ path: '/about', search: '' })
  })

  test('a trailing slash names the same screen', () => {
    expect(parseHash('#/about/')).toEqual({ path: '/about', search: '' })
    expect(parseHash('#/about//?a=b')).toEqual({ path: '/about', search: 'a=b' })
  })

  test('only the first question mark splits the query', () => {
    expect(parseHash('#/x?a=1?b=2')).toEqual({ path: '/x', search: 'a=1?b=2' })
  })
})

describe('sectionOf', () => {
  test('first segment of a path', () => {
    expect(sectionOf('/')).toBe('/')
    expect(sectionOf('/about')).toBe('/about')
    expect(sectionOf('/about/build?x=1')).toBe('/about')
  })
})

describe('hashFor', () => {
  test('targets are always rooted', () => {
    expect(hashFor('/about')).toBe('#/about')
    expect(hashFor('about')).toBe('#/about')
    expect(hashFor('/')).toBe('#/')
  })
})
