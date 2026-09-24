import { describe, expect, it } from 'vitest'
import { contentRef, sha256Hex, utf8Length } from '../src/shared/sha256'

/**
 * The hash has to be right, not merely stable: it is what proves two bricks share
 * a prefix. These are the published FIPS 180-4 / RFC 6234 vectors.
 */
describe('sha256', () => {
  it('matches the published vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })

  it('handles the padding boundaries', () => {
    // 55 bytes is the last length that fits one block; 56 and 64 force another.
    expect(sha256Hex('a'.repeat(55))).toBe('9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318')
    expect(sha256Hex('a'.repeat(56))).toBe('b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a')
    expect(sha256Hex('a'.repeat(64))).toBe('ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb')
  })

  it('hashes a megabyte correctly', () => {
    expect(sha256Hex('a'.repeat(1_000_000)))
      .toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })

  it('hashes UTF-8 bytes, not code units', () => {
    // A CJK string and an ASCII string of the same character count must differ.
    expect(sha256Hex('中文')).not.toBe(sha256Hex('ab'))
    expect(utf8Length('中文')).toBe(6)
    expect(utf8Length('ab')).toBe(2)
  })

  it('gives a 128-bit content ref that tracks the full digest', () => {
    expect(contentRef('abc')).toBe(sha256Hex('abc').slice(0, 32))
    expect(contentRef('abc')).toHaveLength(32)
    expect(contentRef('abc')).not.toBe(contentRef('abd'))
  })
})
