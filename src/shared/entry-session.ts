import type { AppSettings } from './settings'
import type { EntryLocation, SourceResult } from './bridge'
import type { JsonValue, VocabRecord } from './types'
import type { ArticleData, ProviderIssue } from './providers'
import { manualTemplate } from './providers'
import { instantiateMapping } from './mapping'
import { mergeEntry, objectValue, validateIdentity } from './entries'
import { isJsonValue, cloneJson } from './json'
import { isValidLemma } from './protocol'

export class EntrySession {
  lemma: string
  locked = false
  targetEdited = false
  text = ''
  touched = false
  invalid = false
  saving = false
  error = ''
  requestId?: string
  article?: ArticleData
  sources: Record<string, JsonValue> = {}
  examples: Record<string, JsonValue> = { article: { original_word: '', original_sentence: '' } }
  issues: ProviderIssue[] = []
  pending?: { lemma: string; value: JsonValue }
  candidate?: JsonValue
  constructor(readonly location: EntryLocation, public settings: AppSettings, public settingsRevision: string, private records: Map<string, VocabRecord>, boundLemma?: string) {
    this.lemma = boundLemma ?? location.selected.toLowerCase(); this.locked = !!boundLemma
    this.rebuild(false)
  }
  edit(text: string) { this.text = text; this.touched = true }
  setLemma(lemma: string) {
    if (this.locked) return
    this.lemma = lemma; this.targetEdited = true; this.rebuild(this.touched)
  }
  setArticle(article: ArticleData) {
    this.article = article; this.sources.article = { ...article }; this.rebuild(this.touched)
  }
  replaceSettings(settings: AppSettings, revision: string) {
    this.requestId = undefined; this.settings = settings; this.settingsRevision = revision
    this.sources = this.article ? { article: { ...this.article } } : {}
    this.error = '设置已变化，自动请求已取消；草稿保留，可手动重新获取。'
  }
  startRequest(id: string) { this.requestId = id; this.error = '' }
  receive(result: SourceResult): boolean {
    if (this.invalid || result.requestId !== this.requestId) return false
    this.requestId = undefined; this.sources = result.sources; this.examples = result.examples
    this.article = result.article ?? this.article; this.issues = result.issues
    let target = this.lemma
    if (!this.locked && !this.targetEdited && Object.keys(result.sources).some(name => name !== 'article')) {
      const mapped = instantiateMapping(this.settings.saveTemplate, { values: this.sources, examples: this.examples })
      if (mapped.ok) {
        const suggestion = objectValue(mapped.value.value)?.lemma
        if (typeof suggestion === 'string' && isValidLemma(suggestion)) { target = suggestion; if (!this.touched) this.lemma = suggestion }
        else this.issues.push({ code: 'invalid-lemma-suggestion', message: '自动 lemma 缺失或不符合身份语法；当前目标只是待确认建议，请人工检查。' })
      }
    }
    this.rebuild(this.touched, target)
    return true
  }
  requestFailed(id: string, message: string) { if (this.requestId !== id) return; this.requestId = undefined; this.error = message }
  invalidate(message: string) { this.invalid = true; this.requestId = undefined; this.error = message }
  private rebuild(protect: boolean, target = this.lemma) {
    // Examples provide missing-field types; they are never source values.
    const examples: Record<string, JsonValue> = Object.assign(Object.create(null), this.examples)
    for (const profile of this.settings.providers) if (profile.type === 'LLM') {
      const config = objectValue(profile.config)
      if (config && Object.hasOwn(config, 'responseTemplate')) examples[profile.name] = config.responseTemplate
    }
    const mapped = instantiateMapping(this.settings.saveTemplate, { values: this.sources, examples })
    let candidate: JsonValue
    this.issues = this.issues.filter(issue => !['missing-source', 'invalid-source', 'missing-list', 'invalid-expansion', 'empty-source', 'unrecognized-entry'].includes(issue.code))
    if (!mapped.ok) {
      this.issues.push(mapped.error)
      // Explicit manual skeleton remains editable when the configured mapping cannot instantiate.
      const fallback = instantiateMapping(manualTemplate, { values: this.sources, examples })
      candidate = fallback.ok ? fallback.value.value : { lemma: this.lemma }
    } else { candidate = mapped.value.value; this.issues.push(...mapped.value.issues) }
    const root = objectValue(candidate)
    if (root && Object.hasOwn(root, 'lemma')) root.lemma = target
    this.candidate = candidate
    const existing = this.records.get(target)
    const merged = mergeEntry(existing?.value, candidate)
    if (!merged.ok) this.issues.push(merged.error)
    const value = merged.ok ? merged.value : cloneJson(existing!.value)
    if (protect) this.pending = { lemma: target, value }
    else { this.text = JSON.stringify(value, null, 2); this.pending = undefined }
  }
  applyPending() {
    if (!this.pending || (this.locked && this.pending.lemma !== this.lemma)) return
    if (!this.locked) this.lemma = this.pending.lemma
    this.text = JSON.stringify(this.pending.value, null, 2); this.pending = undefined
    // Explicitly applying a result does not authorize later requests to overwrite this draft.
    this.touched = true
  }
  parse(): { ok: true; value: JsonValue } | { ok: false; message: string } {
    if (!isValidLemma(this.lemma) || this.lemma.length > 128) return { ok: false, message: 'lemma 必须为小写 ASCII 英文词，可含内部撇号或连字符，长度不超过 128。' }
    if (this.records.get(this.lemma)?.managed === false) return { ok: false, message: '目标词条位于托管区块外，只读。' }
    try {
      const value: unknown = JSON.parse(this.text)
      if (!isJsonValue(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024) return { ok: false, message: '词条必须是有限且不超过 1 MiB 的 JSON。' }
      const identity = validateIdentity(value, this.lemma, this.records.get(this.lemma)?.value)
      return identity.ok ? { ok: true, value } : { ok: false, message: identity.error.message }
    } catch { return { ok: false, message: '词条 JSON 尚未通过解析。' } }
  }
  confirm(): boolean {
    if (this.invalid || this.saving || !this.parse().ok) return false
    this.locked = true; this.requestId = undefined; this.pending = undefined; this.saving = true; return true
  }
}
