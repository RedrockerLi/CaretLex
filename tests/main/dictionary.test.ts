import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DictionaryCache } from '../../src/main/dictionary-cache'
import { createDictionaryClient } from '../../src/main/dictionary'
import type { DictionaryRuntimeConfig } from '../../src/shared/providers'
import { defaultDictionaryResponse } from '../../src/shared/providers'
import type { DictionaryLookup } from '../../src/shared/dictionary'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const service = createServer((request, response) => { void handler(request, response) })
  await new Promise<void>((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve) })
  cleanups.push(() => new Promise<void>(resolve => { service.closeAllConnections(); service.close(() => resolve()) }))
  const address = service.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}`
}
function cache() {
  const value = new DictionaryCache(':memory:')
  cleanups.push(async () => value.close())
  return value
}
const config: DictionaryRuntimeConfig = {
  timeoutMs: 1000,
  apiKeyRef: 'key-11111111-1111-1111-1111-111111111111',
  responseTemplate: defaultDictionaryResponse
}
const body = JSON.stringify([
  { meta: { id: 'went', stems: ['went', 'go'] }, hwi: { hw: 'went' } },
  {
    meta: { id: 'go:1', stems: ['go', 'goes', 'going', 'gone', 'went'] },
    hwi: { hw: 'go', prs: [{ ipa: 'ˈgoʊ' }] },
    fl: 'verb',
    def: [{ sseq: [[['sense', { dt: [['text', '{bc}to move or travel'], ['vis', [{ t: 'We {it}went{/it} home.' }]]] }]]] }]
  }
])
const lookup: DictionaryLookup = {
  query: 'went',
  candidates: [{ entryId: 'go:1', lemma: 'go', senses: [{ id: 'go:1#0', definition: 'to move', examples: [] }] }],
  fetchedAt: 1
}

describe('createDictionaryClient', () => {
  it('fetches, normalizes and caches a lookup', async () => {
    let requests = 0
    const base = await server((request, response) => {
      requests++
      expect(request.method).toBe('GET')
      expect(request.url).toBe('/went?key=test-key')
      response.setHeader('Content-Type', 'application/json')
      response.end(body)
    })
    const client = createDictionaryClient({ fetch: globalThis.fetch, getKey: async () => 'test-key', cache: cache(), endpoint: base })
    const first = await client.lookup('went', config, new AbortController().signal)
    expect(first).toMatchObject({ ok: true, source: 'network' })
    if (first.ok) expect(first.lookup.candidates[0]).toMatchObject({ lemma: 'go', partOfSpeech: 'verb' })
    const second = await client.lookup('went', config, new AbortController().signal)
    expect(second).toMatchObject({ ok: true, source: 'cache' })
    expect(requests).toBe(1)
  })

  it('fails without a credential when no stale cache exists', async () => {
    const base = await server((_request, response) => { response.end(body) })
    const client = createDictionaryClient({ fetch: globalThis.fetch, getKey: async () => { throw new Error('missing') }, cache: cache(), endpoint: base })
    const result = await client.lookup('went', config, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'dictionary-credential-unavailable' } })
  })

  it('returns an HTTP error without leaking the key', async () => {
    const base = await server((_request, response) => { response.statusCode = 500; response.end('failure') })
    const client = createDictionaryClient({ fetch: globalThis.fetch, getKey: async () => 'test-key', cache: cache(), endpoint: base })
    const result = await client.lookup('went', config, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'dictionary-http-error' } })
    expect(JSON.stringify(result)).not.toContain('test-key')
  })

  it('rejects invalid JSON', async () => {
    const base = await server((_request, response) => { response.end('<html>error</html>') })
    const client = createDictionaryClient({ fetch: globalThis.fetch, getKey: async () => 'test-key', cache: cache(), endpoint: base })
    const result = await client.lookup('went', config, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'dictionary-invalid-response' } })
  })

  it('times out and falls back', async () => {
    const base = await server(() => { /* never respond */ })
    const client = createDictionaryClient({ fetch: globalThis.fetch, getKey: async () => 'test-key', cache: cache(), endpoint: base })
    const result = await client.lookup('went', { ...config, timeoutMs: 20 }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'dictionary-timeout' } })
  })

  it('uses a stale positive cache when the network fails', async () => {
    const value = cache()
    value.put('went', lookup, 0)
    const base = await server((_request, response) => { response.statusCode = 503; response.end('down') })
    const client = createDictionaryClient({ fetch: globalThis.fetch, getKey: async () => 'test-key', cache: value, endpoint: base })
    const result = await client.lookup('went', config, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, source: 'stale-cache' })
    if (result.ok) expect(result.issues.map(issue => issue.code)).toContain('dictionary-stale-cache')
  })

  it('returns cancelled when the caller is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = createDictionaryClient({ fetch: globalThis.fetch, getKey: async () => 'test-key', cache: cache(), endpoint: 'http://127.0.0.1:1' })
    const result = await client.lookup('went', config, controller.signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('reports no-entry for suggestions or empty responses and caches the miss', async () => {
    let requests = 0
    const base = await server((_request, response) => {
      requests++
      response.end(JSON.stringify(['go', 'goo']))
    })
    const value = cache()
    const client = createDictionaryClient({ fetch: globalThis.fetch, getKey: async () => 'test-key', cache: value, endpoint: base })
    const first = await client.lookup('gooo', config, new AbortController().signal)
    expect(first).toMatchObject({ ok: true, source: 'network' })
    if (first.ok) expect(first.issues.map(issue => issue.code)).toContain('dictionary-no-entry')
    const second = await client.lookup('gooo', config, new AbortController().signal)
    expect(second).toMatchObject({ ok: true, source: 'cache' })
    expect(requests).toBe(1)
  })
})
