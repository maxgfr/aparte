import { describe, expect, test } from 'bun:test'
import { toHex, utf8 } from '../../crypto/bytes.ts'
import { sha256 } from '../../crypto/keys.ts'
import { amzDate, signV4, uriEncode } from './sigv4.ts'

/*
 * The worked examples of the Amazon S3 documentation, "Signature Calculations for the Authorization Header:
 * Transferring Payload in a Single Chunk (AWS Signature Version 4)": the example credentials, bucket `examplebucket`,
 * region us-east-1, 2013-05-24.
 */
const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  datetime: '20130524T000000Z',
}

describe('AWS Signature Version 4', () => {
  test('GET Object', async () => {
    const signed = await signV4({
      ...credentials,
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { Range: 'bytes=0-9' },
    })
    expect(toHex(await sha256(utf8(signed.canonicalRequest)))).toBe(
      '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
    )
    expect(signed.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  test('GET Bucket (list objects)', async () => {
    const signed = await signV4({
      ...credentials,
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J',
    })
    expect(signed.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7')
  })

  test('PUT Object', async () => {
    const signed = await signV4({
      ...credentials,
      method: 'PUT',
      url: `https://examplebucket.s3.amazonaws.com/${uriEncode('test$file.text')}`,
      headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      body: utf8('Welcome to Amazon S3.'),
    })
    expect(signed.headers['x-amz-content-sha256']).toBe(
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    )
    expect(signed.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')
  })

  test('the date format and the RFC 3986 encoding', () => {
    expect(amzDate(Date.UTC(2013, 4, 24))).toBe('20130524T000000Z')
    expect(uriEncode("a b!'()*~")).toBe('a%20b%21%27%28%29%2A~')
  })
})
