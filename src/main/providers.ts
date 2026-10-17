import { extractArticle } from './article'
import { CaretLexError, type DocumentRepository, type SettingsRepository } from './repositories'
import { isJsonValue } from '../shared/json'
import { MAX_JSON_BYTES } from '../shared/providers'
import { referencesSource } from '../shared/mapping'
import { presetCompatibility, type ProviderAdapter } from '../shared/providers'
import type { EntryLocation, ProviderFetchInput, SourceResult } from '../shared/bridge'
import type { JsonValue } from '../shared/types'
export class ProviderService {
  private requests = new Map<string, { controller: AbortController; documentId: string }>()
  constructor(private documents: DocumentRepository, private settings: SettingsRepository, readonly adapters: ReadonlyMap<string, ProviderAdapter>) {}
  async article(input: EntryLocation) {
    const document = await this.documents.verifyRevision(input.documentId, input.baseRevision)
    return extractArticle(document.snapshot.text, input.sourceSpan, input.selected)
  }
  descriptions() { return [...this.adapters.values()].map(adapter => ({ type: adapter.type, defaultConfig: adapter.defaultConfig(), hasPreset: adapter.createSavePreset('example') !== null })) }
  preset(type: string, name: string, config: JsonValue) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || name === 'article') throw new CaretLexError('INVALID_NAME', 'provider name 无效。')
    const adapter = this.adapters.get(type)
    if (!adapter) throw new CaretLexError('UNKNOWN_TYPE', '未注册 provider 类型。')
    const checked = adapter.validateConfig(config, false)
    if (!checked.ok) return { template: null, reason: checked.error.message }
    const reason = type === 'LLM' ? presetCompatibility(config) : undefined
    if (reason) return { template: null, reason }
    const template = adapter.createSavePreset(name)
    return template !== null ? { template } : { template: null, reason: '此 provider 没有可用保存预设，请手动配置映射。' }
  }
  cancel(id: string) { this.requests.get(id)?.controller.abort() }
  cancelAll(documentId?: string) { for (const request of this.requests.values()) if (!documentId || request.documentId === documentId) request.controller.abort() }
  async fetch(input: ProviderFetchInput): Promise<SourceResult> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId) || this.requests.has(input.requestId)) throw new CaretLexError('INVALID_REQUEST_ID', 'requestId 无效或已使用。')
    const controller = new AbortController()
    this.requests.set(input.requestId, { controller, documentId: input.documentId })
    const result: SourceResult = { requestId: input.requestId, sources: Object.create(null), examples: Object.create(null), issues: [] }
    try {
      const snapshot = await this.settings.load()
      if (!snapshot.value || snapshot.error || snapshot.revision !== input.settingsRevision) throw new CaretLexError('SETTINGS_CONFLICT', '设置版本已变化或不可用，请重新获取。')
      const article = await this.article(input)
      if (!article.ok) { result.issues.push(article.error); return result }
      result.article = article.value
      result.sources.article = { ...article.value }; result.examples.article = { original_word: '', original_sentence: '' }
      const profile = snapshot.value.providers.find(item => item.enabled && referencesSource(snapshot.value!.saveTemplate, item.name))
      if (profile) {
        const adapter = this.adapters.get(profile.type)
        if (!adapter) throw new CaretLexError('UNKNOWN_TYPE', 'provider 类型未注册。')
        if (profile.type === 'LLM') result.examples[profile.name] = (profile.config as Record<string, JsonValue>).responseTemplate
        const dictionary = snapshot.value.dictionary
        const context = profile.type === 'LLM' && dictionary.enabled
          ? {
              article: article.value,
              dictionary: {
                timeoutMs: dictionary.timeoutMs,
                apiKeyRef: dictionary.apiKeyRef,
                responseTemplate: dictionary.responseTemplate
              }
            }
          : { article: article.value }
        controller.signal.throwIfAborted()
        const response = await adapter.fetch(context, profile.config, controller.signal)
        if (response.ok && (!isJsonValue(response.value) || Buffer.byteLength(JSON.stringify(response.value)) > MAX_JSON_BYTES)) {
          result.issues.push({ code: 'invalid-provider-value', message: 'Provider 返回非 JSON 数据或来源值超过 1 MiB。', sourcePath: profile.name })
        } else if (response.ok) {
          result.sources[profile.name] = response.value
          result.issues.push(...response.issues.map(issue => ({ ...issue, sourcePath: issue.sourcePath ? `${profile.name}.${issue.sourcePath}` : profile.name })))
        } else result.issues.push({ ...response.error, sourcePath: profile.name })
      }
      controller.signal.throwIfAborted()
      await this.documents.verifyRevision(input.documentId, input.baseRevision)
      const latest = await this.settings.load()
      if (latest.error || latest.revision !== input.settingsRevision) throw new CaretLexError('SETTINGS_CONFLICT', '获取期间设置发生变化，结果未应用。')
      return result
    } finally { this.requests.delete(input.requestId) }
  }
}
