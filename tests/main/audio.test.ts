import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AudioStore } from '../../src/main/audio-store'
import { createAudioFetcher } from '../../src/main/audio'

const URL_OK = 'https://media.merriam-webster.com/audio/prons/en/us/mp3/a/apple001.mp3'
const bytes = new Uint8Array([1, 2, 3, 4])
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(fetch: typeof globalThis.fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'caretlex-audio-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const store = new AudioStore(join(dir, 'dictionary.sqlite'))
  cleanups.push(async () => store.close())
  return { store, fetcher: createAudioFetcher({ fetch, store }) }
}
const responder = (body: BodyInit, headers: Record<string, string> = { 'content-type': 'audio/mpeg' }) =>
  vi.fn(async () => new Response(body, { headers })) as unknown as typeof globalThis.fetch

describe('createAudioFetcher', () => {
  it('downloads once, stores the bytes and serves later calls from the store', async () => {
    const fetch = responder(bytes)
    const { store, fetcher } = await fixture(fetch)
    const first = await fetcher.load(URL_OK)
    expect(first?.mime).toBe('audio/mpeg')
    expect(Buffer.from(first!.bytes)).toEqual(Buffer.from(bytes))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.has(URL_OK)).toBe(true)
    const second = await fetcher.load(URL_OK)
    expect(Buffer.from(second!.bytes)).toEqual(Buffer.from(bytes))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses addresses that are not Merriam-Webster media files', async () => {
    const fetch = responder(bytes)
    const { fetcher } = await fixture(fetch)
    expect(await fetcher.load('https://evil.test/apple001.mp3')).toBeUndefined()
    expect(await fetcher.load('https://media.merriam-webster.com/audio/prons/en/us/mp3/a/../../secret.mp3')).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects non-audio content types, failed responses and oversized bodies', async () => {
    const html = await fixture(responder('<html></html>', { 'content-type': 'text/html' }))
    expect(await html.fetcher.load(URL_OK)).toBeUndefined()
    expect(html.store.has(URL_OK)).toBe(false)

    const failed = await fixture(vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof globalThis.fetch)
    expect(await failed.fetcher.load(URL_OK)).toBeUndefined()

    const oversized = await fixture(responder(new Uint8Array(1024 * 1024 + 1)))
    expect(await oversized.fetcher.load(URL_OK)).toBeUndefined()
    expect(oversized.store.has(URL_OK)).toBe(false)
  })

  it('prefetches only valid, not yet stored addresses and swallows failures', async () => {
    const fetch = responder(bytes)
    const { store, fetcher } = await fixture(fetch)
    fetcher.prefetch({ lemma: 'go', ipa: 'ˈgoʊ' })
    fetcher.prefetch({ audio: 'https://evil.test/apple001.mp3' })
    expect(fetch).not.toHaveBeenCalled()
    fetcher.prefetch({ audio: URL_OK })
    await vi.waitFor(() => expect(store.has(URL_OK)).toBe(true))
    expect(fetch).toHaveBeenCalledTimes(1)
    fetcher.prefetch({ audio: URL_OK })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns undefined when the network layer throws', async () => {
    const { fetcher } = await fixture(vi.fn(async () => { throw new Error('offline') }) as unknown as typeof globalThis.fetch)
    expect(await fetcher.load(URL_OK)).toBeUndefined()
  })
})
