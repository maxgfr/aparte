/*
 * Character cards: V1, V2 and V3 JSON, PNG cards built here chunk by chunk (with real CRCs), the embedded lorebook,
 * the system prompt they give, and the damaged inputs refused.
 */
import { describe, expect, test } from 'bun:test'
import { InvalidInputError } from '../contracts/crypto.ts'
import { concat, u32be, utf8 } from '../crypto/bytes.ts'
import { crc32 } from '../sync/providers/zip.ts'
import { cardFromJson, readCard, substituteMacros, systemPromptOf, toCardV2 } from './cards.ts'

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeAndData = concat(utf8(type), data)
  return concat(u32be(data.length), typeAndData, u32be(crc32(typeAndData)))
}

const b64 = (json: unknown) => Buffer.from(JSON.stringify(json), 'utf8').toString('base64')
const tEXt = (keyword: string, value: string) => chunk('tEXt', concat(utf8(keyword), new Uint8Array([0]), utf8(value)))

function png(...chunks: Uint8Array[]): Uint8Array {
  const ihdr = chunk('IHDR', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]))
  return concat(SIGNATURE, ihdr, ...chunks, chunk('IEND', new Uint8Array(0)))
}

const V2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Mira',
    description: '{{char}} keeps the lighthouse.',
    personality: 'Patient, dry humour.',
    scenario: '{{user}} arrives in a storm.',
    first_mes: 'Come in, {{user}}, quickly.',
    mes_example: '<START>\n{{user}}: Hello\n{{char}}: Shut the door.',
    system_prompt: '',
    alternate_greetings: ['Another storm.'],
    tags: ['fantasy'],
    creator: 'someone',
    unknown_field: { anything: true },
    character_book: {
      name: 'Coast',
      scan_depth: 3,
      token_budget: 100,
      entries: [
        { keys: ['lighthouse'], content: 'The lamp is oil-fired.', enabled: true, insertion_order: 2 },
        {
          keys: ['storm'],
          secondary_keys: ['night'],
          selective: true,
          content: 'Storms come at night.',
          enabled: true,
          insertion_order: 1,
          case_sensitive: true,
        },
        { keys: [], content: 'Always: the sea is cold.', constant: true, enabled: true },
        { keys: ['x'], content: '', enabled: true },
      ],
    },
  },
}

describe('character cards', () => {
  test('V2 JSON: fields, embedded lorebook, unknown fields dropped', () => {
    const { persona, lorebook } = cardFromJson(V2)
    expect(persona).toEqual({
      name: 'Mira',
      systemPrompt: '',
      description: '{{char}} keeps the lighthouse.',
      personality: 'Patient, dry humour.',
      scenario: '{{user}} arrives in a storm.',
      firstMessage: 'Come in, {{user}}, quickly.',
      examples: '<START>\n{{user}}: Hello\n{{char}}: Shut the door.',
      creator: 'someone',
      alternateGreetings: ['Another storm.'],
      tags: ['fantasy'],
      source: 'card-v2',
    })
    expect(lorebook?.name).toBe('Coast')
    expect(lorebook?.scanDepth).toBe(3)
    expect(lorebook?.budget).toBe(400)
    expect(lorebook?.entries).toEqual([
      { triggers: ['lighthouse'], content: 'The lamp is oil-fired.', enabled: true, order: 2 },
      {
        triggers: ['storm'],
        secondary: ['night'],
        content: 'Storms come at night.',
        enabled: true,
        order: 1,
        caseSensitive: true,
      },
      { triggers: [], content: 'Always: the sea is cold.', enabled: true, order: 2, constant: true },
    ])
  })

  test('V1 and V3 JSON', () => {
    expect(cardFromJson({ name: 'Old', description: 'Flat card', first_mes: 'Hi' }).persona).toMatchObject({
      name: 'Old',
      description: 'Flat card',
      firstMessage: 'Hi',
    })
    const v3 = cardFromJson({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { ...V2.data, name: 'Mira 3', system_prompt: 'Be {{char}}. {{original}}' },
    })
    expect(v3.persona.source).toBe('card-v3')
    expect(v3.persona.systemPrompt).toBe('Be {{char}}.')
  })

  test('the system prompt is built from the fields, macros substituted, the greeting folded in', () => {
    const { persona } = cardFromJson(V2)
    const prompt = systemPromptOf(persona, 'Ana')
    expect(prompt).toContain('You are Mira.')
    expect(prompt).toContain('Mira keeps the lighthouse.')
    expect(prompt).toContain('Ana arrives in a storm.')
    expect(prompt).toContain("Mira's opening line (already shown to Ana):\nCome in, Ana, quickly.")
    expect(prompt).not.toContain('{{')
    expect(systemPromptOf(persona, 'Ana')).toBe(prompt)
    expect(substituteMacros('<BOT> and <USER>, {{ Char }}', 'B', 'U')).toBe('B and U, B')
  })

  test('PNG cards: chara (V2), ccv3 preferred over chara, iTXt read', () => {
    expect(readCard(png(tEXt('chara', b64(V2)))).persona.name).toBe('Mira')
    const v3 = { spec: 'chara_card_v3', data: { ...V2.data, name: 'Mira V3' } }
    expect(readCard(png(tEXt('chara', b64(V2)), tEXt('ccv3', b64(v3)))).persona.name).toBe('Mira V3')
    const itxt = chunk('iTXt', concat(utf8('chara'), new Uint8Array([0, 0, 0, 0, 0]), utf8(b64(V2))))
    expect(readCard(png(itxt)).persona.name).toBe('Mira')
  })

  test('damaged or foreign inputs are refused', () => {
    const good = png(tEXt('chara', b64(V2)))
    const flipped = new Uint8Array(good)
    flipped[good.length - 20] = (flipped[good.length - 20] ?? 0) ^ 0xff
    expect(() => readCard(flipped)).toThrow(InvalidInputError)
    expect(() => readCard(good.subarray(0, good.length - 12))).toThrow(InvalidInputError)
    expect(() => readCard(png(tEXt('comment', 'hello')))).toThrow(InvalidInputError)
    expect(() => readCard(png(tEXt('chara', '!!not base64!!')))).toThrow(InvalidInputError)
    expect(() => readCard(utf8('{"hello": 1}'))).toThrow(InvalidInputError)
    expect(() => readCard(utf8('not json'))).toThrow(InvalidInputError)
    expect(() => cardFromJson({ spec: 'chara_card_v2', data: { name: '  ' } })).toThrow(InvalidInputError)
  })

  test('long fields are capped', () => {
    const { persona } = cardFromJson({ name: 'Long', description: 'x'.repeat(200_000) })
    expect(persona.description?.length).toBe(64 * 1024)
  })

  test('a character exports back to a V2 card that reads the same', () => {
    const { persona, lorebook } = cardFromJson(V2)
    const again = cardFromJson(toCardV2(persona, lorebook))
    expect(again.persona).toEqual(persona)
    expect(again.lorebook?.entries).toEqual(lorebook?.entries ?? [])
  })
})
