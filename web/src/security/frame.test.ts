import { describe, expect, test } from 'bun:test'
import { type DocumentLike, isolation, REFUSAL, showRefusal } from './frame.ts'

describe('isolation', () => {
  const self = {}

  test('lets a top-level window nobody opened run', () => {
    expect(isolation({ top: self, self, opener: null })).toBeNull()
  })

  test('refuses a framed window, whoever opened it', () => {
    expect(isolation({ top: {}, self, opener: null })).toBe('framed')
    expect(isolation({ top: {}, self, opener: {} })).toBe('framed')
  })

  test('refuses a window another page opened', () => {
    expect(isolation({ top: self, self, opener: {} })).toBe('opened')
  })
})

/** A minimal element tree that records what the refusal builds. */
interface FakeNode {
  tag: string
  textContent: string | null
  attrs: Record<string, string>
  children: FakeNode[]
}

function fakeDocument(): { doc: DocumentLike; body: FakeNode[] } {
  const body: FakeNode[] = [{ tag: 'div', textContent: 'app', attrs: {}, children: [] }]
  const doc: DocumentLike = {
    body: {
      replaceChildren: (...nodes: unknown[]) => {
        body.splice(0, body.length, ...(nodes as FakeNode[]))
      },
    },
    createElement(tag) {
      const node: FakeNode = { tag, textContent: null, attrs: {}, children: [] }
      return Object.assign(node, {
        setAttribute: (name: string, value: string) => {
          node.attrs[name] = value
        },
        append: (...nodes: unknown[]) => {
          node.children.push(...(nodes as FakeNode[]))
        },
      })
    },
  }
  return { doc, body }
}

describe('showRefusal', () => {
  test.each(['framed', 'opened'] as const)('replaces the page with a static note when %s', (reason) => {
    const { doc, body } = fakeDocument()
    showRefusal(reason, doc, 'https://maxgfr.github.io/aparte/')
    expect(body).toHaveLength(1)
    const [main] = body
    expect(main?.tag).toBe('main')
    expect(main?.children.map((c) => [c.tag, c.textContent])).toEqual([
      ['h1', REFUSAL.title],
      ['p', REFUSAL[reason]],
      ['a', REFUSAL.link],
    ])
  })

  test('links to the app in a new tab without an opener or a referrer', () => {
    const { doc, body } = fakeDocument()
    showRefusal('framed', doc, 'https://maxgfr.github.io/aparte/')
    const link = body[0]?.children[2]
    expect(link?.attrs).toEqual({
      href: 'https://maxgfr.github.io/aparte/',
      target: '_blank',
      rel: 'noopener noreferrer',
    })
  })
})
