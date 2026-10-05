import { llmType, checkResponse, MAX_JSON_BYTES, type LlmProviderConfig, type ProviderAdapter, type ProviderContext, type ProviderResult } from '../shared/providers'
import { isJsonValue } from '../shared/json'
import { protocolRequest, responseContent } from './llm-protocols'
import type { JsonValue } from '../shared/types'

export function createLlmAdapter(deps: { fetch: typeof fetch; getKey: (ref: string) => Promise<string> }): ProviderAdapter {
  return {
    ...llmType,
    async fetch(context: ProviderContext, raw: JsonValue, signal: AbortSignal): Promise<ProviderResult> {
      const fail = (code: string, message: string): ProviderResult => ({ ok: false, error: { code, message } })
      const checked = llmType.validateConfig(raw, true)
      if (!checked.ok) return { ok: false, error: checked.error }
      const config = checked.value as unknown as LlmProviderConfig
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), config.timeoutMs)
      const combined = AbortSignal.any([signal, timeout.signal])
      try {
        let key: string | undefined
        if (config.apiKeyRef) {
          try { key = await deps.getKey(config.apiKeyRef) } catch { return fail('credential-unavailable', '本机凭据不可用，请检查设置中的凭据状态。') }
        }
        const prompt = config.prompt.replace(/{{[^{}]*}}/g, variable => {
          if (variable === '{{JSON}}') return JSON.stringify(config.responseTemplate, null, 2)
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
        return { ok: true, value, issues: checkResponse(value, config.responseTemplate) }
      } catch {
        return fail(signal.aborted ? 'cancelled' : timeout.signal.aborted ? 'timeout' : 'network-error', signal.aborted ? '请求已取消。' : timeout.signal.aborted ? 'LLM 请求超时；可手动重试。' : 'LLM 网络请求失败；可检查地址并手动重试。')
      } finally { clearTimeout(timer) }
    }
  }
}
