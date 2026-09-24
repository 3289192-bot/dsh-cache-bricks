/**
 * SHA-256, self-contained.
 *
 * The content-addressed store needs a strong hash to be trustworthy, and this
 * plugin needs it in **both** halves: the host hashes outgoing requests, and the
 * client can hash the same way when it wants to prove two bricks share a prefix.
 * A dependency-free implementation keeps the host half free of Node builtins (so
 * nothing about it is environment-specific), keeps the browser bundle free of
 * polyfills, and lets the hash be verified against published test vectors instead
 * of trusted.
 *
 * Synchronous and byte-oriented: hashing a multi-megabyte request once per model
 * call is cheap next to the call itself.
 */

/** Round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** Initial hash state: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

/** Rotate right. */
function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

/**
 * Hash bytes.
 * @param data - the message.
 * @returns the 32-byte digest.
 */
export function sha256(data: Uint8Array): Uint8Array {
  const length = data.length
  const bitLength = length * 8
  // Pad to a multiple of 64 bytes, with room for the 0x80 byte and the 8-byte length.
  const padded = (((length + 9) + 63) >> 6) << 6
  const buffer = new Uint8Array(padded)
  buffer.set(data)
  buffer[length] = 0x80
  const view = new DataView(buffer.buffer)
  view.setUint32(padded - 8, Math.floor(bitLength / 2 ** 32))
  view.setUint32(padded - 4, bitLength >>> 0)

  const state = H0.slice()
  const schedule = new Uint32Array(64)
  for (let offset = 0; offset < padded; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 64; index += 1) {
      const x = schedule[index - 15]!
      const y = schedule[index - 2]!
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0
    }

    let a = state[0]!
    let b = state[1]!
    let c = state[2]!
    let d = state[3]!
    let e = state[4]!
    let f = state[5]!
    let g = state[6]!
    let h = state[7]!

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + K[index]! + schedule[index]!) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    state[0] = (state[0]! + a) >>> 0
    state[1] = (state[1]! + b) >>> 0
    state[2] = (state[2]! + c) >>> 0
    state[3] = (state[3]! + d) >>> 0
    state[4] = (state[4]! + e) >>> 0
    state[5] = (state[5]! + f) >>> 0
    state[6] = (state[6]! + g) >>> 0
    state[7] = (state[7]! + h) >>> 0
  }

  const digest = new Uint8Array(32)
  for (let index = 0; index < 8; index += 1) {
    const word = state[index]!
    digest[index * 4] = (word >>> 24) & 0xff
    digest[index * 4 + 1] = (word >>> 16) & 0xff
    digest[index * 4 + 2] = (word >>> 8) & 0xff
    digest[index * 4 + 3] = word & 0xff
  }
  return digest
}

/** UTF-8 bytes of a string, without depending on Node's `Buffer`. */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Byte length of a string in UTF-8 (not its character count). */
export function utf8Length(text: string): number {
  return utf8Bytes(text).length
}

/**
 * Hash text or bytes to lowercase hex.
 * @param input - a string (UTF-8 encoded) or raw bytes.
 * @returns 64 hex characters.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const digest = sha256(typeof input === 'string' ? utf8Bytes(input) : input)
  let hex = ''
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * Short content ref: the first 32 hex characters (128 bits).
 *
 * Long enough that a collision is not a practical concern for a few hundred
 * thousand payloads, short enough to sit in a URL and in a record without noise.
 * @param input - a string (UTF-8 encoded) or raw bytes.
 * @returns 32 hex characters.
 */
export function contentRef(input: string | Uint8Array): string {
  return sha256Hex(input).slice(0, 32)
}
