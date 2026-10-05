import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLlmAdapter } from '../../src/main/llm'
import { CredentialRepository } from '../../src/main/credentials'
import { DocumentRepository, SettingsRepository } from '../../src/main/repositories'
import { ProviderService } from '../../src/main/providers'
import { llmType, llmPreset, defaultResponse, providerTypes, type ProviderAdapter } from '../../src/shared/providers'
import { defaultSettings } from '../../src/shared/settings'
import { instantiateMapping } from '../../src/shared/mapping'
import type { JsonValue } from '../../src/shared/types'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'caretlex-provider-test-')); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir }
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const service = createServer((request, response) => { void handler(request, response) })
  await new Promise<void>((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve) })
  cleanups.push(() => new Promise<void>(resolve => { service.closeAllConnections(); service.close(() => resolve()) }))
  const address = service.address(); if (!address || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}`
}
const context = { article: { original_word: 'went', original_sentence: 'She [went] home.' } }
const config = (baseUrl: string, overrides: Record<string, JsonValue> = {}): JsonValue => ({ ...llmType.defaultConfig() as object, baseUrl, model: 'configured-model', ...overrides })
const outer = (content: unknown = JSON.stringify({ ...defaultResponse as object, lemma: 'go', meaning_in_context: '（动词）去', english_definition: 'move', other_meanings: [] }), finish_reason = 'stop', fields = {}) => ({ choices: [{ finish_reason, message: { content, ...fields } }] })
const adapter = (getKey = async () => 'test-key') => createLlmAdapter({ fetch: globalThis.fetch, getKey })

describe('real HTTP Chat Completions protocol with a local simulated server', () => {
  it('preserves base paths and validates prompt, marker, model, auth and JSON mode without recursive variables', async () => {
    let requestCount = 0
    const responseTemplate = { ...defaultResponse as object, lemma: '{{article.original_word}} / {{JSON}} $&' }
    const base = await server(async (request, response) => {
      requestCount++
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      expect(request.url).toBe('/custom/v1/chat/completions')
      expect(request.method).toBe('POST'); expect(request.headers.authorization).toBe('Bearer test-key')
      expect(body.model).toBe('configured-model'); expect(body.stream).toBe(false)
      expect(body.response_format).toEqual({ type: 'json_object' })
      expect(body.messages[1].content).toBe('went | She [went] {{article.original_word}} home. | ' + JSON.stringify(responseTemplate, null, 2) + ' | ' + JSON.stringify(responseTemplate, null, 2))
      expect(JSON.stringify(body)).not.toContain('test-key')
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(outer()))
    })
    const result = await adapter().fetch({ article: { ...context.article, original_sentence: 'She [went] {{article.original_word}} home.' } }, config(base + '/custom/v1///', { prompt: '{{article.original_word}} | {{article.original_sentence}} | {{JSON}} | {{JSON}}', responseTemplate, apiKeyRef: 'key-11111111-1111-1111-1111-111111111111', jsonMode: true }), new AbortController().signal)
    expect(result).toMatchObject({ ok: true, value: { lemma: 'go', other_meanings: [] }, issues: [] }); expect(requestCount).toBe(1)
  })
  it('supports anonymous local services and keeps valid fields with type diagnostics', async () => {
    const base = await server((request, response) => {
      expect(request.headers.authorization).toBeUndefined()
      response.end(JSON.stringify(outer(JSON.stringify({ lemma: 'go', meaning_in_context: 23, other_meanings: [{ meaning: 'one' }, { meaning: 'two', english_definition: 'd', example_sentence: 'e' }], extra: true }))))
    })
    const getKey = vi.fn(async () => 'unused')
    const result = await adapter(getKey).fetch(context, config(base), new AbortController().signal)
    expect(getKey).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, value: { lemma: 'go', extra: true }, issues: expect.arrayContaining([expect.objectContaining({ code: 'field-type', sourcePath: 'meaning_in_context' })]) })
  })
  it.each([
    ['broken envelope', '{bad', 'invalid-envelope'],
    ['missing choices', '{}', 'invalid-envelope'],
    ['empty content', JSON.stringify(outer('')), 'empty-content'],
    ['non-text content', JSON.stringify(outer([])), 'empty-content'],
    ['fenced content', JSON.stringify(outer('```json\n{}\n```')), 'invalid-content-json'],
    ['extra explanation', JSON.stringify(outer('Result: {"lemma":"go"}')), 'invalid-content-json'],
    ['truncated content', JSON.stringify(outer('{}', 'length')), 'unsupported-response'],
    ['filtered content', JSON.stringify(outer('{}', 'content_filter')), 'unsupported-response'],
    ['refusal', JSON.stringify(outer('{}', 'stop', { refusal: 'no' })), 'unsupported-response'],
    ['tools', JSON.stringify(outer('{}', 'stop', { tool_calls: [] })), 'unsupported-response'],
    ['nonfinite', JSON.stringify(outer('{"value":1e999}')), 'invalid-json-value']
  ])('rejects %s without repair', async (_name, body, code) => {
    const base = await server((_request, response) => { response.end(body) })
    expect(await adapter().fetch(context, config(base), new AbortController().signal)).toMatchObject({ ok: false, error: { code } })
  })
  it.each([400, 401, 404, 429])('reports HTTP %i and does not retry or change JSON mode', async status => {
    let count = 0
    const base = await server((_request, response) => { count++; response.writeHead(status); response.end('rejected') })
    const result = await adapter().fetch(context, config(base, { jsonMode: true }), new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'http-error', message: expect.stringContaining(String(status)) } }); expect(count).toBe(1)
  })
  it('handles timeout and caller cancellation while consuming response bodies', async () => {
    const base = await server((_request, response) => { response.writeHead(200); response.write('{'); })
    expect(await adapter().fetch(context, config(base, { timeoutMs: 20 }), new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'timeout' } })
    const controller = new AbortController(); const pending = adapter().fetch(context, config(base), controller.signal)
    setTimeout(() => controller.abort(), 10)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
  it('explicitly cancels a stalled response reader when the request is aborted', async () => {
    const cancelled = vi.fn()
    const fetchBody = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')) },
      cancel() { cancelled() }
    })))
    const llm = createLlmAdapter({ fetch: fetchBody, getKey: async () => '' })
    const pending = llm.fetch(context, config('http://127.0.0.1', { timeoutMs: 20 }), new AbortController().signal)
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Response reader was not cancelled')), 300)
      })])
      expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } })
      expect(cancelled).toHaveBeenCalledOnce()
    } finally { clearTimeout(deadline) }
  })
  it('checks actual bytes for both request and response and rejects invalid UTF-8', async () => {
    const fetchSpy = vi.fn(globalThis.fetch)
    const ai = createLlmAdapter({ fetch: fetchSpy, getKey: async () => '' })
    expect(await ai.fetch(context, config('http://127.0.0.1', { prompt: 'x'.repeat(1024 * 1024) }), new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'request-too-large' } })
    expect(fetchSpy).not.toHaveBeenCalled()
    const large = await server((_request, response) => { response.writeHead(200, { 'Transfer-Encoding': 'chunked' }); response.end('x'.repeat(1024 * 1024 + 1)) })
    expect(await adapter().fetch(context, config(large), new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'response-too-large' } })
    const invalid = await server((_request, response) => { response.end(Buffer.from([0xc3, 0x28])) })
    expect(await adapter().fetch(context, config(invalid), new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'invalid-envelope' } })
  })
  it('never makes an anonymous request for an unavailable credential reference', async () => {
    const fetchSpy = vi.fn(globalThis.fetch)
    const ai = createLlmAdapter({ fetch: fetchSpy, getKey: async () => { throw new Error('not on this computer') } })
    expect(await ai.fetch(context, config('http://127.0.0.1', { apiKeyRef: 'key-11111111-1111-1111-1111-111111111111' }), new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'credential-unavailable' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('local credentials and settings recovery', () => {
  it('creates immutable references, writes 0600 and separates keys from migrated settings', async () => {
    const dir = await temp(); const sync = await temp(); const credentials = new CredentialRepository(dir)
    const oldRef = await credentials.save('old-test-key'); const newRef = await credentials.save('new-test-key')
    expect(oldRef).not.toBe(newRef); expect(await credentials.get(oldRef)).toBe('old-test-key')
    expect((await stat(credentials.path)).mode & 0o777).toBe(0o600)
    const settings = new SettingsRepository(dir); const initial = await settings.load()
    await settings.save({ ...defaultSettings, providers: [{ name: 'ai_main', type: 'LLM', enabled: true, config: config('http://localhost', { apiKeyRef: oldRef }) }] }, initial.revision)
    await expect(settings.save({ ...defaultSettings, providers: [{ name: 'ai_main', type: 'LLM', enabled: true, config: config('http://localhost', { apiKeyRef: newRef }) }] }, initial.revision)).rejects.toMatchObject({ code: 'CONFLICT' })
    const migrated = await settings.migrateTo(join(sync, 'settings.json'))
    const text = await readFile(migrated.path, 'utf8'); expect(text).toContain(oldRef); expect(text).not.toContain(newRef); expect(text).not.toContain('test-key')
    expect(await credentials.status(oldRef)).toEqual({ exists: true }); expect(await credentials.status('key-11111111-1111-1111-1111-111111111111')).toMatchObject({ exists: false, error: expect.any(String) })
    await expect(settings.migrateTo(credentials.path)).rejects.toMatchObject({ code: 'SETTINGS_PATH_RESERVED' })
    await expect(settings.selectExistingPath(credentials.path)).rejects.toMatchObject({ code: 'SETTINGS_PATH_RESERVED' })
  })
  it('preserves corrupt credential bytes and refuses replacement', async () => {
    const dir = await temp(); const credentials = new CredentialRepository(dir); const bytes = Buffer.from('{broken')
    await writeFile(credentials.path, bytes)
    await expect(credentials.save('test-key')).rejects.toMatchObject({ code: 'CREDENTIAL_CORRUPT' })
    expect(await readFile(credentials.path)).toEqual(bytes)
    expect(await credentials.status('key-11111111-1111-1111-1111-111111111111')).toMatchObject({ exists: false, error: expect.stringContaining('损坏') })
  })
  it.each(['{bad', '{"version":1}'])('allows rewriting decodable %s using its original revision', async text => {
    const dir = await temp(); const path = join(dir, 'settings.json'); await writeFile(path, text)
    const settings = new SettingsRepository(dir); const loaded = await settings.load()
    expect(loaded.text).toBe(text); expect(loaded.error).toBeDefined()
    const saved = await settings.save(defaultSettings, loaded.revision); expect(saved.value).toEqual(defaultSettings); expect(saved.value).not.toHaveProperty('version')
  })
  it('does not overwrite undecodable settings and recovers from a damaged pointer by selecting a valid file', async () => {
    const dir = await temp(); const path = join(dir, 'settings.json'); const bytes = Buffer.from([0xc3, 0x28]); await writeFile(path, bytes)
    const settings = new SettingsRepository(dir); const loaded = await settings.load(); expect(loaded.text).toBeUndefined()
    await expect(settings.save(defaultSettings, loaded.revision)).rejects.toMatchObject({ code: 'ENCODING' }); expect(await readFile(path)).toEqual(bytes)
    const fresh = await temp(); await writeFile(join(fresh, 'settings-path.json'), '{broken')
    const valid = join(dir, 'valid.json'); await writeFile(valid, JSON.stringify(defaultSettings))
    const recovery = new SettingsRepository(fresh); expect((await recovery.load()).error).toContain('指针')
    expect((await recovery.selectExistingPath(valid)).value).toEqual(defaultSettings)
  })
})

async function serviceFixture(text = 'She went home.') {
  const dir = await temp(); const path = join(dir, 'article.md'); await writeFile(path, text)
  const documents = new DocumentRepository(); const document = await documents.open(path); cleanups.push(() => documents.close(document.snapshot.id))
  const settings = new SettingsRepository(dir); const snapshot = await settings.load()
  const input = { documentId: document.snapshot.id, baseRevision: document.snapshot.revision, sourceSpan: { start: text.indexOf('went'), end: text.indexOf('went') + 4 }, selected: 'went', requestId: 'request', settingsRevision: snapshot.revision }
  return { dir, path, documents, document, settings, snapshot, input }
}
describe('provider orchestration and captured versions', () => {
  it.each(['__proto__', 'constructor', '__v_isReactive'])('supports the legal instance name %s throughout source namespaces', async name => {
    const fixture = await serviceFixture()
    const template = llmPreset(name)
    const snapshot = await fixture.settings.save({ ...defaultSettings, providers: [{ name, type: 'LLM', enabled: true, config: config('http://localhost') }], saveTemplate: template }, fixture.snapshot.revision)
    const value = { lemma: 'go', meaning_in_context: '去', english_definition: 'move', other_meanings: [] }
    const service = new ProviderService(fixture.documents, fixture.settings, new Map([['LLM', { ...llmType, fetch: async () => ({ ok: true as const, value, issues: [] }) }]]))
    const result = await service.fetch({ ...fixture.input, settingsRevision: snapshot.revision })
    expect(Object.hasOwn(result.sources, name)).toBe(true)
    expect(JSON.parse(JSON.stringify(result)).sources[name]).toEqual(value)
    expect(instantiateMapping(template, { values: result.sources, examples: result.examples })).toMatchObject({ ok: true, value: { value: { lemma: 'go', contexts: [{ original_sentence: 'She [went] home.', meaning_in_context: '去', english_definition: 'move' }], other_meanings: [] } } })
  })

  it('rejects non-JSON adapter data before mapping without evaluating array getters', async () => {
    const fixture = await serviceFixture()
    const snapshot = await fixture.settings.save({ ...defaultSettings, providers: [{ name: 'chosen', type: 'LLM', enabled: true, config: config('http://localhost') }], saveTemplate: llmPreset('chosen') }, fixture.snapshot.revision)
    const getter = vi.fn(() => 'synthetic')
    const accessed: unknown[] = []
    Object.defineProperty(accessed, '0', { enumerable: true, get: getter })
    for (const [index, value] of [Infinity, new Date(), [undefined], accessed].entries()) {
      const service = new ProviderService(fixture.documents, fixture.settings, new Map([['LLM', { ...llmType, fetch: async () => ({ ok: true as const, value: value as JsonValue, issues: [] }) }]]))
      expect(await service.fetch({ ...fixture.input, requestId: `invalid-${index}`, settingsRevision: snapshot.revision })).toMatchObject({ sources: { article: context.article }, issues: [expect.objectContaining({ code: 'invalid-provider-value' })] })
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('never fetches disabled/unreferenced instances and always provides local article', async () => {
    const fixture = await serviceFixture(); const fetcher = vi.fn(async () => ({ ok: true as const, value: null, issues: [] }))
    const service = new ProviderService(fixture.documents, fixture.settings, new Map([['LLM', { ...llmType, fetch: fetcher }]]))
    expect(await service.fetch(fixture.input)).toMatchObject({ sources: { article: { original_sentence: 'She [went] home.' } } }); expect(fetcher).not.toHaveBeenCalled()
    const updated = await fixture.settings.save({ ...defaultSettings, providers: [{ name: 'chosen', type: 'LLM', enabled: true, config: config('http://localhost') }] }, fixture.snapshot.revision)
    await service.fetch({ ...fixture.input, requestId: 'unreferenced', settingsRevision: updated.revision }); expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses the actual instance namespace and can register a future adapter without changing mappings', async () => {
    const fixture = await serviceFixture()
    const future: ProviderAdapter = { type: 'future', defaultConfig: () => null, validateConfig: () => ({ ok: true, value: null }), createSavePreset: name => ({ lemma: `${name}.lemma` }), fetch: vi.fn(async () => ({ ok: true as const, value: { lemma: 'go' }, issues: [] })) }
    providerTypes.set('future', future); cleanups.push(async () => { providerTypes.delete('future') })
    const snapshot = await fixture.settings.save({ ...defaultSettings, providers: [{ name: 'Future-main', type: 'future', enabled: true, config: null }], saveTemplate: future.createSavePreset('Future-main')! }, fixture.snapshot.revision)
    const service = new ProviderService(fixture.documents, fixture.settings, new Map([['future', future]]))
    expect(service.descriptions()).toEqual([{ type: 'future', defaultConfig: null, hasPreset: true }])
    expect(service.preset('future', 'Future-main', null)).toEqual({ template: { lemma: 'Future-main.lemma' } })
    expect(await service.fetch({ ...fixture.input, settingsRevision: snapshot.revision })).toMatchObject({ sources: { 'Future-main': { lemma: 'go' }, article: { original_word: 'went' } } })
  })
  it('cancels by ID safely and rejects document/settings changes during a request', async () => {
    const fixture = await serviceFixture()
    let release!: () => void
    const started = new Promise<void>(done => { release = done })
    let resolveResult!: () => void
    const waiting = new Promise<void>(done => { resolveResult = done })
    const fake = { ...llmType, fetch: vi.fn(async () => { release(); await waiting; return { ok: true as const, value: { lemma: 'go' }, issues: [] } }) }
    const snapshot = await fixture.settings.save({ ...defaultSettings, providers: [{ name: 'chosen', type: 'LLM', enabled: true, config: config('http://localhost') }], saveTemplate: llmPreset('chosen') }, fixture.snapshot.revision)
    const service = new ProviderService(fixture.documents, fixture.settings, new Map([['LLM', fake]]))
    const pending = service.fetch({ ...fixture.input, settingsRevision: snapshot.revision }); await started
    service.cancel('request'); service.cancel('request'); service.cancel('missing'); resolveResult()
    await expect(pending).rejects.toBeDefined()
    await writeFile(fixture.path, 'External went home.')
    await expect(service.fetch({ ...fixture.input, requestId: 'changed', settingsRevision: snapshot.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(service.fetch({ ...fixture.input, requestId: 'settings', settingsRevision: 'stale' })).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
  })
  it('refuses contextual provider fetch if local article cannot be extracted', async () => {
    const fixture = await serviceFixture('She <b>went</b> home.')
    const fetcher = vi.fn(async () => ({ ok: true as const, value: null, issues: [] }))
    const snapshot = await fixture.settings.save({ ...defaultSettings, providers: [{ name: 'chosen', type: 'LLM', enabled: true, config: config('http://localhost') }], saveTemplate: llmPreset('chosen') }, fixture.snapshot.revision)
    const service = new ProviderService(fixture.documents, fixture.settings, new Map([['LLM', { ...llmType, fetch: fetcher }]]))
    expect(await service.fetch({ ...fixture.input, settingsRevision: snapshot.revision })).toMatchObject({ sources: {}, issues: [expect.objectContaining({ code: 'article-unavailable' })] }); expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('LLM protocol selection with real HTTP and a local simulated server', () => {
  const resultJson = JSON.stringify({ ...defaultResponse as object, lemma: 'go', meaning_in_context: '（动词）去', english_definition: 'move', other_meanings: [] })
  const envelopes = {
    'openai-responses': { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: resultJson }] }] },
    'anthropic-messages': { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: resultJson }] },
    gemini: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'reasoning', thought: true }, { text: resultJson }] } }] }
  }
  it.each(['openai-responses', 'anthropic-messages', 'gemini'] as const)('sends and parses %s without switching protocols', async apiType => {
    let count = 0
    const base = await server(async (request, response) => {
      count++
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      expect(request.method).toBe('POST'); expect(request.headers['content-type']).toBe('application/json')
      const prompt = apiType === 'openai-responses' ? body.input : apiType === 'anthropic-messages' ? body.messages[0].content : body.contents[0].parts[0].text
      expect(prompt).toContain('Response JSON example:\n' + JSON.stringify(defaultResponse, null, 2))
      expect(prompt).not.toContain('{{JSON}}')
      expect(JSON.stringify(body)).not.toContain('test-key')
      expect(request.url).not.toContain('test-key')
      if (apiType === 'openai-responses') {
        expect(request.url).toBe('/custom/v1/responses'); expect(request.headers.authorization).toBe('Bearer test-key')
        expect(body).toMatchObject({ model: 'configured-model', stream: false, input: expect.stringContaining('She [went] home.'), instructions: expect.stringContaining('Return only valid JSON'), text: { format: { type: 'json_object' } }, max_output_tokens: 4096 })
        expect(body.messages).toBeUndefined()
      } else if (apiType === 'anthropic-messages') {
        expect(request.url).toBe('/custom/v1/messages'); expect(request.headers['x-api-key']).toBe('test-key')
        expect(request.headers['anthropic-version']).toBe('2023-06-01'); expect(request.headers.authorization).toBeUndefined()
        expect(body).toMatchObject({ model: 'configured-model', stream: false, max_tokens: 4096, system: expect.stringContaining('Return only valid JSON'), messages: [{ role: 'user', content: expect.stringContaining('She [went] home.') }] })
        expect(body.response_format).toBeUndefined()
      } else {
        expect(request.url).toBe('/custom/v1/models/configured-model:generateContent'); expect(request.headers['x-goog-api-key']).toBe('test-key')
        expect(request.headers.authorization).toBeUndefined()
        expect(body).toMatchObject({ contents: [{ role: 'user', parts: [{ text: expect.stringContaining('She [went] home.') }] }], systemInstruction: { parts: [{ text: expect.stringContaining('Return only valid JSON') }] }, generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096 } })
      }
      response.end(JSON.stringify(envelopes[apiType]))
    })
    expect(await adapter().fetch(context, config(base + '/custom/v1///', { apiType, jsonMode: apiType !== 'anthropic-messages', apiKeyRef: 'key-11111111-1111-1111-1111-111111111111' }), new AbortController().signal)).toMatchObject({ ok: true, value: { lemma: 'go' }, issues: [] })
    expect(count).toBe(1)
  })
  it.each([
    ['openai-responses', { status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } }],
    ['openai-responses', { status: 'completed', output: [{ type: 'function_call' }] }],
    ['openai-responses', { status: 'completed', output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] }],
    ['anthropic-messages', { type: 'message', role: 'assistant', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] }],
    ['anthropic-messages', { type: 'message', role: 'assistant', stop_reason: 'refusal', content: [] }],
    ['anthropic-messages', { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'tool_use' }] }],
    ['gemini', { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] }],
    ['gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'tool' } }] } }] }]
  ])('rejects incomplete, refused or tool %s responses', async (apiType, body) => {
    const base = await server((_request, response) => { response.end(JSON.stringify(body)) })
    expect(await adapter().fetch(context, config(base, { apiType }), new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'unsupported-response' } })
  })
  it.each(['openai-responses', 'anthropic-messages', 'gemini'] as const)('rejects fenced %s content and supports anonymous services', async apiType => {
    const envelope = JSON.parse(JSON.stringify(envelopes[apiType]).replace(resultJson.replace(/"/g, '\\"'), '```json\\n{}\\n```'))
    const base = await server((request, response) => {
      expect(request.headers.authorization).toBeUndefined(); expect(request.headers['x-api-key']).toBeUndefined(); expect(request.headers['x-goog-api-key']).toBeUndefined()
      response.end(JSON.stringify(envelope))
    })
    expect(await adapter().fetch(context, config(base, { apiType }), new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'invalid-content-json' } })
  })
  it('requires a supported API type and positive output limit; Anthropic cannot enable json_object', () => {
    const invalid: Array<Record<string, JsonValue>> = [{ apiType: 'unknown' }, { apiType: null }, { apiType: 'anthropic-messages', jsonMode: true }, { maxOutputTokens: 0 }, { maxOutputTokens: 1.5 }, { apiType: 'gemini', model: '../other' }]
    for (const overrides of invalid) {
      expect(llmType.validateConfig(config('https://example.com/v1', overrides), true).ok).toBe(false)
    }
    expect(llmType.validateConfig(config('https://example.com/v1', { apiType: 'gemini', model: 'models/gemini-test' }), true).ok).toBe(true)
  })
})
