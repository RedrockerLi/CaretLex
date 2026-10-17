import type { DictionaryRuntimeConfig, ProviderIssue } from '../shared/providers'
import { normalizeLearnersResponse, type DictionaryLookup } from '../shared/dictionary'
import type { DictionaryCache } from './dictionary-cache'

const DEFAULT_ENDPOINT = 'https://www.dictionaryapi.com/api/v3/references/learners/json'
const MAX_RESPONSE_BYTES = 1024 * 1024
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000

export type DictionaryLookupResult =
  | { ok: true; lookup: DictionaryLookup; source: 'cache' | 'network' | 'stale-cache'; issues: ProviderIssue[] }
  | { ok: false; error: ProviderIssue }

export interface DictionaryClient {
  lookup(word: string, config: DictionaryRuntimeConfig, signal: AbortSignal): Promise<DictionaryLookupResult>
}

function issue(code: string, message: string, sourcePath?: string): ProviderIssue {
  return { code, message, ...(sourcePath ? { sourcePath } : {}) }
}

export function createDictionaryClient(deps: {
  fetch: typeof fetch
  getKey: (ref: string) => Promise<string>
  cache: DictionaryCache
  endpoint?: string
}): DictionaryClient {
  const endpoint = deps.endpoint ?? DEFAULT_ENDPOINT
  const stale = (query: string): DictionaryLookup | undefined => {
    const value = deps.cache.getStale(query)
    return value && value.candidates.length ? value : undefined
  }
  return {
    async lookup(word, config, signal): Promise<DictionaryLookupResult> {
      if (signal.aborted) return { ok: false, error: issue('cancelled', '词典请求已取消。') }
      const query = word.trim().toLowerCase()
      const cached = deps.cache.get(query)
      if (cached) return { ok: true, lookup: cached, source: 'cache', issues: [] }
      let key: string
      try {
        if (!config.apiKeyRef) throw new Error('missing')
        key = (await deps.getKey(config.apiKeyRef)).trim()
        if (!key) throw new Error('empty')
      } catch {
        const old = stale(query)
        if (old) return { ok: true, lookup: old, source: 'stale-cache', issues: [issue('dictionary-stale-cache', '词典凭据不可用，已使用过期缓存。')] }
        return { ok: false, error: issue('dictionary-credential-unavailable', '词典凭据不可用，请检查设置中的 Key。') }
      }
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), config.timeoutMs)
      const combined = AbortSignal.any([signal, timeout.signal])
      try {
        const url = `${endpoint}/${encodeURIComponent(word)}?key=${encodeURIComponent(key)}`
        const response = await deps.fetch(url, { method: 'GET', signal: combined, redirect: 'error' })
        if (!response.ok) {
          await response.body?.cancel()
          const old = stale(query)
          if (old) return { ok: true, lookup: old, source: 'stale-cache', issues: [issue('dictionary-stale-cache', `词典服务返回 HTTP ${response.status}，已使用过期缓存。`)] }
          return { ok: false, error: issue('dictionary-http-error', `词典服务返回 HTTP ${response.status}，已回退到 LLM。`) }
        }
        if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
          await response.body?.cancel()
          return { ok: false, error: issue('dictionary-response-too-large', '词典响应超过 1 MiB。') }
        }
        if (!response.body) return { ok: false, error: issue('dictionary-invalid-response', '词典响应体为空。') }
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        const cancelRead = () => { void reader.cancel().catch(() => undefined) }
        combined.addEventListener('abort', cancelRead, { once: true })
        try {
          if (combined.aborted) cancelRead()
          combined.throwIfAborted()
          while (true) {
            const item = await reader.read()
            combined.throwIfAborted()
            if (item.done) break
            size += item.value.byteLength
            if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return { ok: false, error: issue('dictionary-response-too-large', '词典响应超过 1 MiB。') } }
            chunks.push(item.value)
          }
        } finally { combined.removeEventListener('abort', cancelRead); reader.releaseLock() }
        let raw: unknown
        try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return { ok: false, error: issue('dictionary-invalid-response', '词典响应不是有效 UTF-8 JSON。') } }
        const lookup = normalizeLearnersResponse(word, raw)
        deps.cache.put(query, lookup, lookup.candidates.length ? null : NEGATIVE_TTL_MS)
        return {
          ok: true,
          lookup,
          source: 'network',
          issues: lookup.candidates.length ? [] : [issue('dictionary-no-entry', '词典没有可用词条，已回退到 LLM。')]
        }
      } catch {
        if (signal.aborted) return { ok: false, error: issue('cancelled', '词典请求已取消。') }
        const timedOut = timeout.signal.aborted
        const old = stale(query)
        if (old) return {
          ok: true,
          lookup: old,
          source: 'stale-cache',
          issues: [issue('dictionary-stale-cache', timedOut ? '词典请求超时，已使用过期缓存。' : '词典网络请求失败，已使用过期缓存。')]
        }
        return {
          ok: false,
          error: issue(timedOut ? 'dictionary-timeout' : 'dictionary-network-error', timedOut ? '词典请求超时，已回退到 LLM。' : '词典网络请求失败，已回退到 LLM。')
        }
      } finally { clearTimeout(timer) }
    }
  }
}
