import type { CoreResult, JsonValue } from './types'
import { isJsonValue, cloneJson } from './json'

export interface ArticleData { original_word: string; original_sentence: string }
export interface ProviderIssue { code: string; message: string; sourcePath?: string }
export type ProviderResult = { ok: true; value: JsonValue; issues: ProviderIssue[] } | { ok: false; error: ProviderIssue }
export interface DictionaryRuntimeConfig { timeoutMs: number; apiKeyRef?: string; responseTemplate: JsonValue }
export interface ProviderContext { article: ArticleData; dictionary?: DictionaryRuntimeConfig }
export interface ProviderType {
  type: string
  defaultConfig(): JsonValue
  validateConfig(config: unknown, enabled: boolean): CoreResult<JsonValue>
  createSavePreset(name: string): JsonValue | null
}
export interface ProviderAdapter extends ProviderType {
  fetch(context: ProviderContext, config: JsonValue, signal: AbortSignal): Promise<ProviderResult>
}
export interface LlmProviderConfig {
  apiType: LlmApiType; baseUrl: string; model: string; apiKeyRef?: string; prompt: string
  responseTemplate: JsonValue; jsonMode: boolean; timeoutMs: number; maxOutputTokens: number
}
export const llmApiTypes = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions', endpoint: '/chat/completions', placeholder: 'https://api.openai.com/v1', jsonMode: true },
  { value: 'openai-responses', label: 'OpenAI Responses', endpoint: '/responses', placeholder: 'https://api.openai.com/v1', jsonMode: true },
  { value: 'anthropic-messages', label: 'Anthropic Messages', endpoint: '/messages', placeholder: 'https://api.anthropic.com/v1', jsonMode: false },
  { value: 'gemini', label: 'Gemini Generate Content', endpoint: '/models/{model}:generateContent', placeholder: 'https://generativelanguage.googleapis.com/v1beta', jsonMode: true }
] as const
export type LlmApiType = typeof llmApiTypes[number]['value']
export const MAX_JSON_BYTES = 1024 * 1024
export const defaultResponse: JsonValue = {
  lemma: '', meaning_in_context: '', english_definition: '',
  other_meanings: [{ meaning: '', english_definition: '', example_sentence: '' }]
}
export const defaultDictionaryResponse: JsonValue = {
  lemma: '', context_sense_id: '', meaning_in_context: '', english_definition: '',
  other_meanings: [{ sense_id: '', meaning: '', english_definition: '', example_sentence: '' }]
}
export const defaultPrompt = `Explain only the marked occurrence in the sentence. Provide its dictionary lemma.
Use “（词性）中文翻译” for meaning_in_context and other_meanings[].meaning.
Use English for english_definition and example_sentence. Give other meanings as appropriate; an empty list is allowed.
Word: {{article.original_word}}
Sentence: {{article.original_sentence}}
Return only valid JSON matching the following response example. No Markdown fences or explanations. Array lengths may vary.
Response JSON example:
{{JSON}}`
export const defaultDictionaryPrompt = `Explain only the marked occurrence in the sentence.
A reference from Merriam-Webster's Learner's Dictionary is provided below.
Choose the lemma and the sense IDs that fit the sentence.
Use “（词性）中文翻译” for meaning_in_context and other_meanings[].meaning.
When a sense_id is valid, use that sense's dictionary definition for english_definition.
When the reference is unavailable or no sense_id applies, write a concise English definition yourself.
Write an English example_sentence for each other meaning. Do not copy dictionary examples.
Word: {{article.original_word}}
Sentence: {{article.original_sentence}}
Dictionary reference:
{{dictionary}}
Return only valid JSON matching the following response example. No Markdown fences or explanations. Array lengths may vary.
Response JSON example:
{{JSON}}`
/** 发布过的默认 Prompt；升级时整串匹配替换，用户改过的内容不动。 */
export const legacyDefaultPrompt = `Explain only the marked occurrence in the sentence. Provide its dictionary lemma.
Use “（词性）中文翻译” for meaning_in_context and other_meanings[].meaning.
Use English for english_definition and example_sentence. Give other meanings as appropriate; an empty list is allowed.
Word: {{article.original_word}}
Sentence: {{article.original_sentence}}
Response JSON example:
{{JSON}}`
export function llmPreset(name: string): JsonValue {
  return {
    lemma: `${name}.lemma`,
    contexts: [{ original_sentence: 'article.original_sentence', meaning_in_context: `${name}.meaning_in_context`, english_definition: `${name}.english_definition` }],
    other_meanings: [{ meaning: `${name}.other_meanings[].meaning`, english_definition: `${name}.other_meanings[].english_definition`, example_sentence: `${name}.other_meanings[].example_sentence` }]
  }
}
export const manualTemplate: JsonValue = {
  lemma: '', contexts: [{ original_sentence: 'article.original_sentence', meaning_in_context: '', english_definition: '' }], other_meanings: []
}
export function jsonKind(value: JsonValue): string { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value }
function signature(value: JsonValue): string {
  if (Array.isArray(value)) return `array:${value.length ? signature(value[0]) : '?'}`
  if (value && typeof value === 'object') return JSON.stringify(Object.keys(value).sort().map(key => [key, signature(value[key])]))
  return jsonKind(value)
}
export function validateExample(value: JsonValue): CoreResult<true> {
  if (Array.isArray(value)) {
    if (value.some(item => signature(item) !== signature(value[0]))) return { ok: false, error: { code: 'heterogeneous-example', message: '响应示例的数组元素必须声明同一种结构。' } }
    for (const item of value) { const result = validateExample(item); if (!result.ok) return result }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) { const result = validateExample(item); if (!result.ok) return result }
  }
  return { ok: true, value: true }
}
export function checkResponse(value: JsonValue, example: JsonValue, path = ''): ProviderIssue[] {
  const issues: ProviderIssue[] = []
  const walk = (actual: JsonValue | undefined, expected: JsonValue, at: string) => {
    if (actual === undefined || jsonKind(actual) !== jsonKind(expected)) {
      issues.push({ code: actual === undefined ? 'missing-field' : 'field-type', message: `${at || '根值'} 应为 ${jsonKind(expected)}。`, sourcePath: at })
      return
    }
    if (typeof actual === 'string' && !actual.trim()) issues.push({ code: 'empty-field', message: `${at || '根值'} 为空，待人工检查。`, sourcePath: at })
    if (Array.isArray(expected) && expected.length && Array.isArray(actual)) actual.forEach((item, index) => walk(item, expected[0], `${at}[${index}]`))
    else if (expected && typeof expected === 'object' && !Array.isArray(expected) && actual && typeof actual === 'object' && !Array.isArray(actual)) {
      for (const [key, item] of Object.entries(expected)) walk(Object.hasOwn(actual, key) ? actual[key] : undefined, item, at ? `${at}.${key}` : key)
    }
  }
  walk(value, example, path)
  return issues
}
export const llmType: ProviderType = {
  type: 'LLM',
  defaultConfig: () => ({ apiType: 'openai-chat', baseUrl: '', model: '', prompt: defaultPrompt, responseTemplate: cloneJson(defaultResponse), jsonMode: false, timeoutMs: 60000, maxOutputTokens: 4096 }),
  createSavePreset: llmPreset,
  validateConfig(config, enabled) {
    const fail = (message: string): CoreResult<never> => ({ ok: false, error: { code: 'invalid-llm-config', message } })
    if (!isJsonValue(config) || !config || typeof config !== 'object' || Array.isArray(config)) return fail('LLM config 必须是 JSON 对象。')
    if (Object.keys(config).some(key => !['apiType', 'baseUrl', 'model', 'apiKeyRef', 'prompt', 'responseTemplate', 'jsonMode', 'timeoutMs', 'maxOutputTokens'].includes(key))) return fail('LLM config 含有未知字段；Key 必须使用本机凭据引用。')
    const protocol = llmApiTypes.find(item => item.value === config.apiType)
    if (!protocol) return fail('请选择支持的 API 类型。')
    if (typeof config.baseUrl !== 'string' || typeof config.model !== 'string') return fail('Base URL 和模型必须是字符串。')
    if (enabled) {
      try { const url = new URL(config.baseUrl); if (config.baseUrl.trim() !== config.baseUrl || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail('Base URL 必须是无认证信息、查询或片段的 HTTP/HTTPS 地址。') } catch { return fail('启用 LLM 需要合法的 HTTP/HTTPS Base URL。') }
      if (!config.model.trim()) return fail('启用 LLM 需要非空模型名称。')
      if (config.apiType === 'gemini' && !/^[A-Za-z0-9_.-]+$/.test(config.model.replace(/^models\//, ''))) return fail('Gemini 模型应为模型名称，可带 models/ 前缀。')
    }
    if (config.apiKeyRef !== undefined && (typeof config.apiKeyRef !== 'string' || !/^key-[a-f0-9-]{36}$/.test(config.apiKeyRef))) return fail('apiKeyRef 格式无效。')
    if (typeof config.prompt !== 'string' || typeof config.jsonMode !== 'boolean') return fail('prompt 必须是字符串，jsonMode 必须是布尔值。')
    if (config.jsonMode && !protocol.jsonMode) return fail('Anthropic Messages 不支持 json_object 模式，请关闭 JSON mode；JSON 内容仍按响应示例检查。')
    if (!Number.isInteger(config.maxOutputTokens) || Number(config.maxOutputTokens) < 1 || Number(config.maxOutputTokens) > 2147483647) return fail('maxOutputTokens 必须为 1–2147483647 的整数。')
    const variables = config.prompt.match(/{{[^{}]*}}/g) ?? []
    if (variables.some(variable => !['{{article.original_word}}', '{{article.original_sentence}}', '{{JSON}}', '{{dictionary}}'].includes(variable)) || /{{|}}/.test(config.prompt.replace(/{{[^{}]*}}/g, ''))) return fail('prompt 含有不支持的变量。')
    if (!Number.isInteger(config.timeoutMs) || Number(config.timeoutMs) <= 0 || Number(config.timeoutMs) > 2147483647) return fail('timeoutMs 必须为 1–2147483647 的整数。')
    if (!Object.hasOwn(config, 'responseTemplate')) return fail('必须提供响应 JSON 示例。')
    const checked = validateExample(config.responseTemplate)
    if (!checked.ok) return checked
    // 旧默认 Prompt 整串升级：过去随请求发送的 JSON 指令已并入默认 Prompt 正文。
    const value = config.prompt === legacyDefaultPrompt ? { ...config, prompt: defaultPrompt } : config
    return { ok: true, value }
  }
}
export const providerTypes = new Map<string, ProviderType>([['LLM', llmType]])
function exampleCompatibility(actual: JsonValue | undefined, required: JsonValue): boolean {
  if (actual === undefined || jsonKind(actual) !== jsonKind(required)) return false
  if (Array.isArray(required) && required.length) return Array.isArray(actual) && actual.length > 0 && exampleCompatibility(actual[0], required[0])
  if (required && typeof required === 'object' && !Array.isArray(required)) return !!actual && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(required).every(([key, value]) => exampleCompatibility(Object.hasOwn(actual, key) ? actual[key] : undefined, value))
  return true
}
export function presetCompatibility(config: JsonValue): string | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Object.hasOwn(config, 'responseTemplate')) return '响应示例不可用。'
  return exampleCompatibility(config.responseTemplate, defaultResponse) ? undefined : '响应示例缺少默认预设要求的字段、类型或数组元素结构。'
}
export function dictionaryPresetCompatibility(responseTemplate: JsonValue): string | undefined {
  return exampleCompatibility(responseTemplate, defaultDictionaryResponse) ? undefined : '词典增强响应示例缺少必要字段、类型或数组元素结构。'
}
export function isDefaultSaveStructure(value: JsonValue): boolean {
  const keys = (item: JsonValue, wanted: string[]) => !!item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).sort().join(',') === wanted.sort().join(',')
  if (!keys(value, ['lemma', 'contexts', 'other_meanings'])) return false
  const root = value as Record<string, JsonValue>
  return typeof root.lemma === 'string' && Array.isArray(root.contexts) && root.contexts.length === 1 && keys(root.contexts[0], ['original_sentence', 'meaning_in_context', 'english_definition'])
    && Object.values(root.contexts[0] as object).every(item => typeof item === 'string')
    && Array.isArray(root.other_meanings) && root.other_meanings.length <= 1 && root.other_meanings.every(item => keys(item, ['meaning', 'english_definition', 'example_sentence']) && Object.values(item as object).every(child => typeof child === 'string'))
}
