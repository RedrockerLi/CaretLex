import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AudioStore } from '../../src/main/audio-store'
import { DictionaryCache } from '../../src/main/dictionary-cache'
import type { DictionaryLookup } from '../../src/shared/dictionary'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'caretlex-audio-store-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const bytes = new Uint8Array([1, 2, 3, 4, 5])
const lookup: DictionaryLookup = {
  query: 'went',
  candidates: [{ entryId: 'go:1', lemma: 'go', senses: [{ id: 'go:1#0', definition: 'to move', examples: [] }] }],
  fetchedAt: 1
}

describe('AudioStore', () => {
  it('stores, reads and reports audio bytes', async () => {
    const store = new AudioStore(join(await tempDir(), 'dictionary.sqlite'))
    cleanups.push(async () => store.close())
    expect(store.has('https://example.test/a.mp3')).toBe(false)
    store.put('https://example.test/a.mp3', 'audio/mpeg', bytes)
    expect(store.has('https://example.test/a.mp3')).toBe(true)
    expect(store.get('https://example.test/a.mp3')).toEqual({ mime: 'audio/mpeg', bytes })
    expect(store.stats()).toEqual({ entries: 1, bytes: 5, available: true })
  })

  it('overwrites an existing url and ignores empty payloads', async () => {
    const store = new AudioStore(join(await tempDir(), 'dictionary.sqlite'))
    cleanups.push(async () => store.close())
    store.put('u', 'audio/mpeg', bytes)
    store.put('u', 'audio/ogg', new Uint8Array([9]))
    store.put('empty', 'audio/mpeg', new Uint8Array())
    expect(store.get('u')).toEqual({ mime: 'audio/ogg', bytes: new Uint8Array([9]) })
    expect(store.has('empty')).toBe(false)
    expect(store.stats()).toMatchObject({ entries: 1, bytes: 1 })
  })

  it('keeps audio when the lookup cache is cleared', async () => {
    const path = join(await tempDir(), 'dictionary.sqlite')
    const store = new AudioStore(path)
    const cache = new DictionaryCache(path)
    cleanups.push(async () => { store.close(); cache.close() })
    cache.put('went', lookup, null)
    store.put('u', 'audio/mpeg', bytes)
    cache.clear()
    expect(cache.stats().entries).toBe(0)
    expect(store.get('u')).toEqual({ mime: 'audio/mpeg', bytes })
  })

  it('clears every row and resets stats', async () => {
    const store = new AudioStore(join(await tempDir(), 'dictionary.sqlite'))
    cleanups.push(async () => store.close())
    store.put('u', 'audio/mpeg', bytes)
    store.clear()
    expect(store.has('u')).toBe(false)
    expect(store.stats()).toMatchObject({ entries: 0, bytes: 0, available: true })
  })

  it('degrades to a no-op when the database cannot be opened', async () => {
    const store = new AudioStore(await tempDir())
    expect(store.stats()).toEqual({ entries: 0, bytes: 0, available: false })
    expect(store.has('u')).toBe(false)
    expect(store.get('u')).toBeUndefined()
    expect(() => store.put('u', 'audio/mpeg', bytes)).not.toThrow()
    expect(() => store.clear()).not.toThrow()
    store.close()
  })
})
