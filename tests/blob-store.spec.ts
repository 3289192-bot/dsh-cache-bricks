import { describe, expect, it } from 'vitest'
import { BlobStore } from '../src/host/blob-store'

describe('BlobStore', () => {
  it('gives equal payloads the same ref and stores them once', () => {
    const store = new BlobStore()
    // The whole point: 273 near-identical requests must not become 273 copies.
    const first = store.put({ messages: [{ role: 'user', content: 'hi' }], tools: ['a'] })
    const second = store.put({ tools: ['a'], messages: [{ content: 'hi', role: 'user' }] })
    expect(first?.hash).toBe(second?.hash)
    expect(first?.added).toBe(true)
    expect(second?.added).toBe(false)
    expect(store.stats().blobs).toBe(1)
  })

  it('returns a string payload as the string it was, even when it looks like JSON', () => {
    // Raw tool arguments are exactly this shape; parsing them on the way out
    // would quietly hand the Tools tab an object instead of the model's text.
    const store = new BlobStore()
    const ref = store.put('{"path":"a.ts"}')!
    expect(store.get(ref.hash)).toBe('{"path":"a.ts"}')
    expect(store.put('plain text')!.hash).not.toBe(ref.hash)
    expect(store.get(store.put('plain text')!.hash)).toBe('plain text')
  })

  it('round-trips a payload through its ref', () => {
    const store = new BlobStore()
    const ref = store.put({ a: 1, nested: { b: [1, 2, 3] } })!
    expect(store.get(ref.hash)).toEqual({ a: 1, nested: { b: [1, 2, 3] } })
    expect(store.has(ref.hash)).toBe(true)
    expect(store.stats().hits).toBe(1)
  })

  it('reports a miss for an unknown or evicted ref instead of throwing', () => {
    const store = new BlobStore({ maxBlobs: 1 })
    const first = store.put({ one: 1 })!
    const second = store.put({ two: 2 })!
    expect(store.get(first.hash)).toBeUndefined()
    expect(store.has(first.hash)).toBe(false)
    expect(store.get(second.hash)).toEqual({ two: 2 })
    expect(store.stats().misses).toBe(1)
    expect(store.stats().evicted).toBe(1)
  })

  it('refuses a payload that exceeds the per-blob limit and says so', () => {
    const store = new BlobStore({ maxBlobBytes: 64 })
    const huge = store.put({ text: 'x'.repeat(500) })
    expect(huge).toBeUndefined()
    expect(store.stats().skipped).toBe(1)
    expect(store.stats().blobs).toBe(0)
  })

  it('keeps the store inside its byte budget, evicting the least recently used', () => {
    const store = new BlobStore({ maxTotalBytes: 220, maxBlobBytes: 1000 })
    const first = store.put({ pad: 'a'.repeat(80) })!
    const second = store.put({ pad: 'b'.repeat(80) })!
    // Touch `first` so `second` becomes the least recently used.
    expect(store.get(first.hash)).toBeDefined()
    const third = store.put({ pad: 'c'.repeat(80) })!
    expect(store.stats().bytes).toBeLessThanOrEqual(220)
    expect(store.has(third.hash)).toBe(true)
    expect(store.has(second.hash)).toBe(false)
    expect(store.has(first.hash)).toBe(true)
  })

  it('never evicts below one blob, even when a single payload fills the budget', () => {
    const store = new BlobStore({ maxTotalBytes: 10, maxBlobBytes: 1000 })
    const only = store.put({ pad: 'z'.repeat(50) })!
    expect(store.has(only.hash)).toBe(true)
  })

  it('clears on demand', () => {
    const store = new BlobStore()
    store.put({ a: 1 })
    store.clear()
    expect(store.stats().blobs).toBe(0)
    expect(store.stats().bytes).toBe(0)
  })
})
