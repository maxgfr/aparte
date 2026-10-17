/*
 * Review: spec/FORMAT.md section 1 says every string this format stores MUST be well-formed Unicode and a reader
 * rejects a lone surrogate as `corrupt`. JSON.parse accepts the escape `\ud800` and yields a lone surrogate, so a
 * keyslot whose `format`, `kind` or a kdf string holds one reaches step 2 and is reported `unsupported-keyslot`.
 * The Rust reader (serde_json) rejects the same bytes as `corrupt`, so the two implementations disagree.
 */
import { describe, expect, test } from 'bun:test'
import { CorruptError } from '../contracts/crypto.ts'
import { parseKeyslot } from './keyslot.ts'

const CANONICAL =
  '{"format":"aparte/1","type":"keyslot","vault":"6dy7f47u6x3pp6hz7l57z7p674","slot":"ceirceirceirceirceirceirce",' +
  '"kind":"passphrase","kdf":{"alg":"argon2id","v":19,"m":19456,"t":2,"p":1,"salt":"IiIiIiIiIiIiIiIiIiIiIg",' +
  '"secretKey":true},"commit":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE","wrap":{"iv":"MzMzMzMzMzMzMzMz",' +
  '"ct":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC"},' +
  '"mkCheck":"AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM"}\n'

const PASSKEY =
  '{"format":"aparte/1","type":"keyslot","vault":"6dy7f47u6x3pp6hz7l57z7p674","slot":"ceirceirceirceirceirceirce",' +
  '"kind":"passkey","kdf":{"alg":"prf","credentialId":"AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",' +
  '"rpId":"aparte.example","prfSalt":"u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7s"},' +
  '"commit":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE","wrap":{"iv":"MzMzMzMzMzMzMzMz",' +
  '"ct":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC"},' +
  '"mkCheck":"AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM"}\n'

const enc = (text: string) => new TextEncoder().encode(text)

describe('review: a lone surrogate in a keyslot is corrupt (FORMAT.md section 1)', () => {
  test('the base file parses', () => {
    expect(parseKeyslot(enc(CANONICAL)).kind).toBe('passphrase')
    expect(parseKeyslot(enc(PASSKEY)).kind).toBe('passkey')
  })

  test.each([
    ['format', CANONICAL.replace('"format":"aparte/1"', '"format":"\\ud800"')],
    ['kind', CANONICAL.replace('"kind":"passphrase"', '"kind":"\\ud800"')],
    ['kdf.alg', CANONICAL.replace('"alg":"argon2id"', '"alg":"\\udc00"')],
    ['kdf.rpId', PASSKEY.replace('"rpId":"aparte.example"', '"rpId":"\\ud83d"')],
  ])('%s holding a lone surrogate', (_, text) => {
    expect(() => parseKeyslot(enc(text))).toThrow(CorruptError)
  })
})
