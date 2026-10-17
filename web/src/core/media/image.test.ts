import { describe, expect, test } from 'bun:test'
import {
  checkInput,
  cleanName,
  fitWithin,
  ImageError,
  isPhotoFile,
  MAX_INPUT_BYTES,
  mayHaveAlpha,
  stripJpegMetadata,
} from './image.ts'

describe('photo rules', () => {
  test('fitWithin keeps the ratio, never upscales and never reaches zero', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 })
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 })
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(20000, 1)).toEqual({ width: 2048, height: 1 })
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 })
  })

  test('accepts images by type, or by name without a type; refuses SVG and other files', () => {
    expect(isPhotoFile({ type: 'image/jpeg', size: 1 })).toBe(true)
    expect(isPhotoFile({ type: '', size: 1, name: 'IMG_0001.HEIC' })).toBe(true)
    expect(isPhotoFile({ type: 'image/svg+xml', size: 1 })).toBe(false)
    expect(isPhotoFile({ type: 'application/pdf', size: 1, name: 'a.pdf' })).toBe(false)
  })

  test('checkInput refuses too large and unsupported files with their code', () => {
    const code = (f: Parameters<typeof checkInput>[0]) => {
      try {
        checkInput(f)
        return null
      } catch (e) {
        return e instanceof ImageError ? e.code : 'other'
      }
    }
    expect(code({ type: 'image/png', size: MAX_INPUT_BYTES + 1 })).toBe('too-large')
    expect(code({ type: 'text/html', size: 10 })).toBe('unsupported')
    expect(code({ type: 'image/svg+xml', size: 10 })).toBe('unsupported')
    expect(code({ type: 'image/heic', size: 10 })).toBeNull()
  })

  test('transparency-capable sources are told apart from JPEG', () => {
    expect(mayHaveAlpha({ type: 'image/png', size: 1 })).toBe(true)
    expect(mayHaveAlpha({ type: 'image/jpeg', size: 1 })).toBe(false)
    expect(mayHaveAlpha({ type: '', size: 1, name: 'shot.webp' })).toBe(true)
  })

  test('cleanName drops directories and caps the length', () => {
    expect(cleanName('C:\\Users\\me\\photo.jpg')).toBe('photo.jpg')
    expect(cleanName('/private/var/IMG.jpg')).toBe('IMG.jpg')
    expect(cleanName('  ')).toBeUndefined()
    expect(cleanName(undefined)).toBeUndefined()
    expect(cleanName(`${'a'.repeat(200)}.jpg`)?.length).toBe(120)
  })
})

/** A JPEG segment: marker, big-endian length (which counts itself), payload. */
function segment(marker: number, payload: string | number[]): number[] {
  const bytes = typeof payload === 'string' ? [...payload].map((c) => c.charCodeAt(0)) : payload
  const length = bytes.length + 2
  return [0xff, marker, length >> 8, length & 0xff, ...bytes]
}

describe('stripJpegMetadata', () => {
  const soi = [0xff, 0xd8]
  const jfif = segment(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0')
  const exif = segment(0xe1, 'Exif\0\0MM\0*GPS-CANARY')
  const xmp = segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')
  const icc = segment(0xe2, 'ICC_PROFILE\0\x01\x01profile')
  const otherApp2 = segment(0xe2, 'FPXR\0maker data')
  const iptc = segment(0xed, 'Photoshop 3.0\x008BIM')
  const adobe = segment(0xee, 'Adobe\0d\0\0\0\0\x01')
  const comment = segment(0xfe, 'shot on a phone')
  const dqt = segment(0xdb, [0, ...new Array(64).fill(1)])
  const sof = segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0])
  // The scan: its header, entropy-coded data with a stuffed 0xFF 0x00 and a restart marker, then the end.
  const scan = [...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9]

  test('drops EXIF, XMP, IPTC, comments and other APPn, keeps what decodes the pixels, byte for byte', () => {
    const input = new Uint8Array([
      ...soi,
      ...jfif,
      ...exif,
      ...xmp,
      ...icc,
      ...otherApp2,
      ...iptc,
      ...adobe,
      ...comment,
      ...dqt,
      ...sof,
      ...scan,
    ])
    const out = stripJpegMetadata(input)
    expect([...out]).toEqual([...soi, ...jfif, ...icc, ...adobe, ...dqt, ...sof, ...scan])
    const text = new TextDecoder('latin1').decode(out)
    expect(text).not.toContain('Exif')
    expect(text).not.toContain('GPS-CANARY')
    expect(text).not.toContain('xmpmeta')
    // Stripping is idempotent.
    expect([...stripJpegMetadata(out)]).toEqual([...out])
  })

  test('keeps fill bytes before a marker and everything after the start of scan', () => {
    const input = new Uint8Array([...soi, 0xff, ...exif, ...dqt, ...scan, ...comment])
    expect([...stripJpegMetadata(input)]).toEqual([...soi, ...dqt, ...scan, ...comment])
  })

  test('refuses what is not a well-formed JPEG', () => {
    const code = (bytes: number[]) => {
      try {
        stripJpegMetadata(new Uint8Array(bytes))
        return null
      } catch (e) {
        return e instanceof ImageError ? e.code : 'other'
      }
    }
    expect(code([0x89, 0x50, 0x4e, 0x47])).toBe('decode')
    expect(code([...soi, ...dqt])).toBe('decode')
    expect(code([...soi, 0xff, 0xe1, 0xff, 0xff, 1, 2])).toBe('decode')
    expect(code([...soi, 0x00, ...dqt, ...scan])).toBe('decode')
    expect(code([...soi, 0xff, 0xd9])).toBe('decode')
    expect(code([...soi, 0xff, 0xe1, 0x00, 0x01, ...scan])).toBe('decode')
  })
})
