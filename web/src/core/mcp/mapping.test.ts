/* Mapping MCP tools to registry tools and MCP results to what the model reads (mapping.ts). */
import { describe, expect, test } from 'bun:test'
import {
  annotationsOf,
  descriptionOf,
  inputSchemaOf,
  MAX_DESCRIPTION_CHARS,
  MAX_IMAGES,
  MAX_RESULT_CHARS,
  prefixFor,
  registryNames,
  toToolResult,
} from './mapping.ts'

describe('names', () => {
  test('prefixes are lowercase ASCII, start with a letter and are unique', () => {
    expect(prefixFor('GitHub', [])).toBe('github')
    expect(prefixFor('Café Ünïcode', [])).toBe('cafeunicode')
    expect(prefixFor('42 tools', [])).toBe('tools')
    expect(prefixFor('—', [])).toBe('mcp')
    expect(prefixFor('GitHub', ['github', 'github2'])).toBe('github3')
    expect(prefixFor('averyveryverylongservername', [])).toMatch(/^[a-z][a-z0-9]{0,15}$/)
  })

  test('registry names are safe, stable, at most 64 characters and never clash', () => {
    const names = registryNames('gh', ['search.issues', 'search_issues', 'a'.repeat(80), 'x/y', ''])
    const all = [...names.values()]
    for (const n of all) expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(new Set(all).size).toBe(all.length)
    expect(names.get('x/y')).toBe('gh__x_y')
    // The first in MCP-name order keeps the plain name; the clash gets a hash.
    expect(names.get('search.issues')).toBe('gh__search_issues')
    expect(names.get('search_issues')).toMatch(/^gh__search_issues_[0-9a-z]{7}$/)
    // The order the server lists them in does not matter.
    expect(registryNames('gh', ['search_issues', 'search.issues'])).toEqual(
      registryNames('gh', ['search.issues', 'search_issues']),
    )
  })
})

describe('definitions', () => {
  test('annotations follow MCP defaults', () => {
    expect(annotationsOf({ name: 'a' })).toEqual({ readOnly: false, destructive: true, openWorld: true })
    expect(annotationsOf({ name: 'a', annotations: { readOnlyHint: true, destructiveHint: true } })).toEqual({
      readOnly: true,
      destructive: false,
      openWorld: true,
    })
    expect(annotationsOf({ name: 'a', annotations: { destructiveHint: false, openWorldHint: false } })).toEqual({
      readOnly: false,
      destructive: false,
      openWorld: false,
    })
  })

  test('input schemas must be JSON object schemas', () => {
    expect(inputSchemaOf({ name: 'a', inputSchema: { properties: {} } })).toEqual({
      ok: true,
      schema: { type: 'object', properties: {} },
    })
    expect(inputSchemaOf({ name: 'a', inputSchema: { type: 'string' } }).ok).toBe(false)
    expect(inputSchemaOf({ name: 'a', inputSchema: [] }).ok).toBe(false)
    expect(inputSchemaOf({ name: 'a', inputSchema: { type: 'object', default: Number.NaN } }).ok).toBe(false)
    expect(inputSchemaOf({ name: 'a', inputSchema: { type: 'object', description: 'x'.repeat(70_000) } }).ok).toBe(
      false,
    )
  })

  test('descriptions fall back to the title and are capped', () => {
    expect(descriptionOf({ name: 'a', title: 'Alpha' })).toBe('Alpha')
    expect(descriptionOf({ name: 'a' })).toBe('a')
    expect(descriptionOf({ name: 'a', description: 'd'.repeat(MAX_DESCRIPTION_CHARS + 5) })).toHaveLength(
      MAX_DESCRIPTION_CHARS,
    )
  })
})

describe('results', () => {
  test('texts, errors and structured content', () => {
    expect(toToolResult({ content: [{ type: 'text', text: 'hi' }] })).toEqual({
      content: [{ type: 'text', text: 'hi' }],
    })
    expect(toToolResult({ content: [{ type: 'text', text: 'no' }], isError: true }).isError).toBe(true)
    expect(toToolResult({ content: [], structuredContent: { n: 1 } })).toEqual({
      content: [{ type: 'json', value: { n: 1 } }],
    })
    expect(toToolResult({}).content).toEqual([{ type: 'text', text: '' }])
  })

  test('an oversized result is cut, and the cut is said', () => {
    const result = toToolResult({
      content: [
        { type: 'text', text: 'a'.repeat(MAX_RESULT_CHARS - 10) },
        { type: 'text', text: 'b'.repeat(100) },
        { type: 'text', text: 'c'.repeat(100) },
      ],
    })
    const texts = result.content.map((c) => (c.type === 'text' ? c.text : ''))
    expect(texts.slice(0, -1).join('').length).toBe(MAX_RESULT_CHARS)
    expect(texts.at(-1)).toContain(`returned ${MAX_RESULT_CHARS + 190} characters`)
    expect(result.details).toEqual({ truncatedFrom: MAX_RESULT_CHARS + 190 })
  })

  test('images are decoded up to the cap; other content is named, never decoded', () => {
    const png = btoa('\x89PNG....')
    const many = Array.from({ length: MAX_IMAGES + 2 }, () => ({ type: 'image', data: png, mimeType: 'image/png' }))
    const result = toToolResult({
      content: [
        ...many,
        { type: 'image', data: png, mimeType: 'image/svg+xml' },
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'file:///a.txt', text: 'inside' } },
        { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAAA', mimeType: 'application/zip' } },
        { type: 'resource_link', uri: 'https://example.org/x', name: 'x' },
      ],
    })
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(MAX_IMAGES)
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    expect(text).toContain('[audio content, not shown]')
    expect(text).toContain('[resource file:///a.txt]\ninside')
    expect(text).toContain('[binary resource file:///b.bin (application/zip), not shown]')
    expect(text).toContain('[resource link: x <https://example.org/x>]')
    expect(text).toContain('3 image(s) left out')
  })
})
