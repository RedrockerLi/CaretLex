import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DictionaryCache } from '../../src/main/dictionary-cache'
import type { DictionaryLookup } from '../../src/shared/dictionary'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'caretlex-dictionary-cache-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const lookup: DictionaryLookup = {
  query: 'went',
  candidates: [{
    entryId: 'go:1', lemma: 'go', partOfSpeech: 'verb',
    senses: [{ id: 'go:1#0', definition: 'to move or travel', examples: ['We went home.'] }]
  }],
  fetchedAt: 1
}
const emptyLookup: DictionaryLookup = { query: 'gooo', candidates: [], fetchedAt: 1 }

describe('DictionaryCache', () => {
  it('stores positive lookups permanently and reports stats', async () => {
    const cache = new DictionaryCache(join(await tempDir(), 'dictionary.sqlite'))
    cleanups.push(async () => cache.close())
    cache.put('went', lookup, null)
    expect(cache.get('went')).toEqual(lookup)
    expect(cache.getStale('went')).toEqual(lookup)
    const stats = cache.stats()
    expect(stats.available).toBe(true)
    expect(stats.entries).toBe(1)
    expect(stats.bytes).toBeGreaterThan(0)
  })

  it('expires negative lookups but keeps them for stale fallback', async () => {
    const cache = new DictionaryCache(join(await tempDir(), 'dictionary.sqlite'))
    cleanups.push(async () => cache.close())
    cache.put('gooo', emptyLookup, 5)
    expect(cache.get('gooo')).toEqual(emptyLookup)
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(cache.get('gooo')).toBeUndefined()
    expect(cache.getStale('gooo')).toEqual(emptyLookup)
  })

  it('clears all rows and resets stats', async () => {
    const cache = new DictionaryCache(join(await tempDir(), 'dictionary.sqlite'))
    cleanups.push(async () => cache.close())
    cache.put('went', lookup, null)
    cache.clear()
    expect(cache.get('went')).toBeUndefined()
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0, available: true })
  })

  it('drops rows from an older schema version on open', async () => {
    const path = join(await tempDir(), 'dictionary.sqlite')
    const first = new DictionaryCache(path)
    first.close()
    const raw = new DatabaseSync(path)
    raw.prepare('INSERT INTO lookups (query, product, schema_version, payload, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('old', 'learners', 0, JSON.stringify({ ...lookup, query: 'old' }), Date.now())
    raw.close()
    const cache = new DictionaryCache(path)
    cleanups.push(async () => cache.close())
    expect(cache.get('old')).toBeUndefined()
    expect(cache.stats().entries).toBe(0)
  })

  it('removes a corrupt payload and treats it as a miss', async () => {
    const path = join(await tempDir(), 'dictionary.sqlite')
    const cache = new DictionaryCache(path)
    cleanups.push(async () => cache.close())
    const raw = new DatabaseSync(path)
    raw.prepare('INSERT INTO lookups (query, product, schema_version, payload, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('broken', 'learners', 1, '{not json', Date.now())
    raw.close()
    expect(cache.get('broken')).toBeUndefined()
    expect(cache.stats().entries).toBe(0)
  })

  it('degrades to a no-op when the database cannot be opened', async () => {
    const cache = new DictionaryCache(await tempDir())
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0, available: false })
    expect(cache.get('went')).toBeUndefined()
    expect(cache.getStale('went')).toBeUndefined()
    expect(() => cache.put('went', lookup, null)).not.toThrow()
    expect(() => cache.clear()).not.toThrow()
    cache.close()
  })
})
