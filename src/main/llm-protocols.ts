import type { CoreResult, JsonValue } from '../shared/types'
import type { LlmProviderConfig } from '../shared/providers'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value)
const fail = (message: string, code = 'unsupported-response'): CoreResult<never> => ({ ok: false, error: { code, message } })
const contentResult = (text: unknown): CoreResult<string> => typeof text === 'string' && text.trim()
  ? { ok: true, value: text } : fail('LLM 响应缺少非空 JSON 文本。', 'empty-content')

/** Protocol-specific envelopes; content is never repaired or extracted from Markdown. */
export function responseContent(config: LlmProviderConfig, outer: unknown): CoreResult<string> {
  if (!object(outer)) return fail('LLM 响应必须是 JSON 对象。', 'invalid-envelope')
  switch (config.apiType) {
    case 'openai-chat': {
      if (!Array.isArray(outer.choices)) return fail('Chat Completions 响应缺少 choices 数组。', 'invalid-envelope')
      const choice = outer.choices[0]
      if (!object(choice) || choice.finish_reason !== 'stop' || !object(choice.message) || choice.message.refusal || choice.message.tool_calls || choice.message.function_call) return fail('Chat Completions 响应拒绝、截断、过滤或包含工具调用。')
      return contentResult(choice.message.content)
    }
    case 'openai-responses': {
      if (outer.status !== 'completed' || outer.error || outer.incomplete_details) return fail('Responses 响应未完成、被拒绝或已截断。')
      if (!Array.isArray(outer.output)) return fail('Responses 响应缺少 output 数组。', 'invalid-envelope')
      const texts: string[] = []
      for (const item of outer.output) {
        if (!object(item)) return fail('Responses output 格式无效。', 'invalid-envelope')
        if (item.type === 'reasoning') continue
        if (item.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) return fail('Responses 包含不支持的输出类型或未完成的消息。')
        for (const part of item.content) {
          if (!object(part) || part.type !== 'output_text' || typeof part.text !== 'string') return fail('Responses 包含拒绝或非文本内容。')
          texts.push(part.text)
        }
      }
      return contentResult(texts.join(''))
    }
    case 'anthropic-messages': {
      if (outer.type !== 'message' || outer.role !== 'assistant' || outer.stop_reason !== 'end_turn') return fail('Anthropic 响应拒绝、截断或包含工具调用。')
      if (!Array.isArray(outer.content)) return fail('Anthropic 响应缺少 content 数组。', 'invalid-envelope')
      const texts: string[] = []
      for (const part of outer.content) {
        if (!object(part)) return fail('Anthropic 内容格式无效。', 'invalid-envelope')
        if (part.type === 'thinking' || part.type === 'redacted_thinking') continue
        if (part.type !== 'text' || typeof part.text !== 'string') return fail('Anthropic 包含拒绝或不支持的非文本内容。')
        texts.push(part.text)
      }
      return contentResult(texts.join(''))
    }
    case 'gemini': {
      if (object(outer.promptFeedback) && outer.promptFeedback.blockReason) return fail('Gemini 拒绝了本次请求。')
      if (!Array.isArray(outer.candidates) || !outer.candidates.length) return fail('Gemini 响应缺少 candidates。', 'invalid-envelope')
      const candidate = outer.candidates[0]
      if (!object(candidate) || candidate.finishReason !== 'STOP') return fail('Gemini 响应拒绝、截断或未正常完成。')
      if (!object(candidate.content) || !Array.isArray(candidate.content.parts)) return fail('Gemini 响应缺少文本 parts。', 'invalid-envelope')
      const texts: string[] = []
      for (const part of candidate.content.parts) {
        if (!object(part) || typeof part.text !== 'string' || Object.keys(part).some(key => !['text', 'thought', 'thoughtSignature'].includes(key))) return fail('Gemini 包含不支持的工具调用或非文本内容。')
        if (part.thought !== true) texts.push(part.text)
      }
      return contentResult(texts.join(''))
    }
  }
}

/** Bodies carry the substituted Prompt only; the app adds no hidden instruction text. */
export function protocolRequest(config: LlmProviderConfig, prompt: string, key?: string): { url: string; headers: Record<string, string>; body: string } {
  const base = config.baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let path: string
  let body: JsonValue
  switch (config.apiType) {
    case 'openai-chat':
      path = '/chat/completions'
      if (key) headers.Authorization = `Bearer ${key}`
      body = { model: config.model, messages: [{ role: 'user', content: prompt }], stream: false, max_completion_tokens: config.maxOutputTokens, ...(config.jsonMode ? { response_format: { type: 'json_object' } } : {}) }
      break
    case 'openai-responses':
      path = '/responses'
      if (key) headers.Authorization = `Bearer ${key}`
      body = { model: config.model, input: prompt, stream: false, max_output_tokens: config.maxOutputTokens, ...(config.jsonMode ? { text: { format: { type: 'json_object' } } } : {}) }
      break
    case 'anthropic-messages':
      path = '/messages'
      headers['anthropic-version'] = '2023-06-01'
      if (key) headers['x-api-key'] = key
      body = { model: config.model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: config.maxOutputTokens }
      break
    case 'gemini':
      path = `/models/${encodeURIComponent(config.model.replace(/^models\//, ''))}:generateContent`
      if (key) headers['x-goog-api-key'] = key
      body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: config.maxOutputTokens, ...(config.jsonMode ? { responseMimeType: 'application/json' } : {}) } }
      break
  }
  return { url: base + path, headers, body: JSON.stringify(body) }
}
