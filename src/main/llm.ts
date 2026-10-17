import { llmType, checkResponse, MAX_JSON_BYTES, type LlmProviderConfig, type ProviderAdapter, type ProviderContext, type ProviderIssue, type ProviderResult } from '../shared/providers'
import { assembleEnrichedEntry, buildDictionaryReference, type DictionaryLookup } from '../shared/dictionary'
import { isJsonValue } from '../shared/json'
import { protocolRequest, responseContent } from './llm-protocols'
import type { JsonValue } from '../shared/types'
import type { DictionaryClient, DictionaryLookupResult } from './dictionary'

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function createLlmAdapter(deps: { fetch: typeof fetch; getKey: (ref: string) => Promise<string>; dictionary?: DictionaryClient }): ProviderAdapter {
  return {
    ...llmType,
    async fetch(context: ProviderContext, raw: JsonValue, signal: AbortSignal): Promise<ProviderResult> {
      const fail = (code: string, message: string): ProviderResult => ({ ok: false, error: { code, message } })
      const checked = llmType.validateConfig(raw, true)
      if (!checked.ok) return { ok: false, error: checked.error }
      const config = checked.value as unknown as LlmProviderConfig
      if (signal.aborted) return fail('cancelled', '请求已取消。')
      let lookup: DictionaryLookup | undefined
      const dictionaryIssues: ProviderIssue[] = []
      if (context.dictionary) {
        if (!deps.dictionary) {
          dictionaryIssues.push({ code: 'dictionary-not-configured', message: '词典增强已启用，但词典客户端不可用；已回退到 LLM。' })
        } else {
          let result: DictionaryLookupResult
          try { result = await deps.dictionary.lookup(context.article.original_word, context.dictionary, signal) }
          catch { result = { ok: false, error: { code: 'dictionary-network-error', message: '词典请求失败，已回退到 LLM。' } } }
          if (!result.ok) {
            if (result.error.code === 'cancelled' || signal.aborted) return fail('cancelled', '请求已取消。')
            dictionaryIssues.push(result.error)
          } else {
            lookup = result.lookup.candidates.length ? result.lookup : undefined
            dictionaryIssues.push(...result.issues)
          }
        }
      }
      if (signal.aborted) return fail('cancelled', '请求已取消。')
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), config.timeoutMs)
      const combined = AbortSignal.any([signal, timeout.signal])
      try {
        let key: string | undefined
        if (config.apiKeyRef) {
          try { key = await deps.getKey(config.apiKeyRef) } catch { return fail('credential-unavailable', '本机凭据不可用，请检查设置中的凭据状态。') }
        }
        const responseTemplate = context.dictionary ? context.dictionary.responseTemplate : config.responseTemplate
        const reference: JsonValue = context.dictionary && lookup
          ? buildDictionaryReference(lookup, context.article.original_word)
          : { available: false, word: context.article.original_word, reason: dictionaryIssues[0]?.code ?? (context.dictionary ? 'dictionary-unavailable' : 'dictionary-disabled') }
        const prompt = config.prompt.replace(/{{[^{}]*}}/g, variable => {
          if (variable === '{{JSON}}') return JSON.stringify(responseTemplate, null, 2)
          if (variable === '{{dictionary}}') return JSON.stringify(reference, null, 2)
          return variable === '{{article.original_word}}' ? context.article.original_word : context.article.original_sentence
        })
        const { url, headers, body } = protocolRequest(config, prompt, key)
        if (Buffer.byteLength(body) > MAX_JSON_BYTES) return fail('request-too-large', 'LLM 请求体超过 1 MiB，未发送。')
        combined.throwIfAborted()
        const response = await deps.fetch(url, {
          method: 'POST', headers, body, signal: combined, redirect: 'error'
        })
        combined.throwIfAborted()
        if (!response.ok) { await response.body?.cancel(); return fail('http-error', `LLM 服务返回 HTTP ${response.status}，请调整配置后手动重试。`) }
        if (Number(response.headers.get('content-length') ?? 0) > MAX_JSON_BYTES) { await response.body?.cancel(); return fail('response-too-large', 'LLM 响应超过 1 MiB。') }
        if (!response.body) return fail('empty-response', 'LLM 响应体为空。')
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
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
            if (size > MAX_JSON_BYTES) { await reader.cancel(); return fail('response-too-large', 'LLM 响应超过 1 MiB。') }
            chunks.push(item.value)
          }
        } finally { combined.removeEventListener('abort', cancelRead); reader.releaseLock() }
        let outer: unknown
        try { outer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return fail('invalid-envelope', 'LLM HTTP 响应不是有效 UTF-8 JSON。') }
        const content = responseContent(config, outer)
        if (!content.ok) return { ok: false, error: content.error }
        let value: unknown
        try { value = JSON.parse(content.value) } catch { return fail('invalid-content-json', 'LLM 内容不是纯 JSON；不会抽取、修补或剥离代码围栏。') }
        if (!isJsonValue(value)) return fail('invalid-json-value', 'LLM 返回非有限或不可序列化的 JSON。')
        if (context.dictionary) {
          const hasSense = (id: JsonValue | undefined): boolean => typeof id === 'string' && !!id && !!lookup?.candidates.some(candidate => candidate.senses.some(sense => sense.id === id))
          const filledByDictionary = (issue: ProviderIssue): boolean => {
            if (issue.code !== 'empty-field' || !issue.sourcePath) return false
            if (!lookup) return issue.sourcePath === 'context_sense_id' || /^other_meanings\[\d+\]\.sense_id$/.test(issue.sourcePath)
            if (issue.sourcePath === 'english_definition') return isObject(value) && hasSense(value.context_sense_id)
            const match = /^other_meanings\[(\d+)\]\.english_definition$/.exec(issue.sourcePath)
            if (!match || !isObject(value)) return false
            const items = value.other_meanings
            if (!Array.isArray(items)) return false
            const item = items[Number(match[1])]
            return !!item && typeof item === 'object' && !Array.isArray(item) && hasSense((item as Record<string, JsonValue>).sense_id)
          }
          const issues = checkResponse(value, context.dictionary.responseTemplate).filter(issue => !filledByDictionary(issue))
          const assembled = assembleEnrichedEntry(value, lookup)
          if (!assembled.ok) return { ok: false, error: assembled.error }
          return { ok: true, value: assembled.value, issues: [...dictionaryIssues, ...issues, ...assembled.issues] }
        }
        return { ok: true, value, issues: checkResponse(value, config.responseTemplate) }
      } catch {
        return fail(signal.aborted ? 'cancelled' : timeout.signal.aborted ? 'timeout' : 'network-error', signal.aborted ? '请求已取消。' : timeout.signal.aborted ? 'LLM 请求超时；可手动重试。' : 'LLM 网络请求失败；可检查地址并手动重试。')
      } finally { clearTimeout(timer) }
    }
  }
}
