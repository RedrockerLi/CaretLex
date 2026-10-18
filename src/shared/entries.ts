import { cloneJson } from './json'
import type { CoreResult, JsonValue } from './types'
export function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}
function defaultFields(root: Record<string, JsonValue>): boolean {
  return Array.isArray(root.contexts) && Array.isArray(root.other_meanings) && root.contexts.every(item => {
    const row = objectValue(item)
    return row && typeof row.original_sentence === 'string' && typeof row.meaning_in_context === 'string' && typeof row.english_definition === 'string'
  })
}
export function validateIdentity(value: JsonValue, lemma: string, existing?: JsonValue): CoreResult<true> {
  const root = objectValue(value)
  const previous = objectValue(existing)
  const requiresLemma = previous && (Object.hasOwn(previous, 'lemma') || defaultFields(previous))
  if ((root && Object.hasOwn(root, 'lemma') && root.lemma !== lemma) || (requiresLemma && (!root || root.lemma !== lemma))) {
    return { ok: false, error: { code: 'lemma-locked', message: `词条身份已锁定为 ${lemma}；根级 lemma 不能更改或删除。` } }
  }
  // Current default-shaped values always carry their identity; arbitrary JSON remains readable/writable.
  if (root && defaultFields(root) && root.lemma !== lemma) return { ok: false, error: { code: 'lemma-locked', message: `默认 contexts 结构必须保留 lemma: ${lemma}。` } }
  return { ok: true, value: true }
}
function contexts(value: JsonValue): Record<string, JsonValue>[] | undefined {
  const root = objectValue(value)
  if (!root || typeof root.lemma !== 'string' || !Array.isArray(root.contexts) || !Array.isArray(root.other_meanings)) return undefined
  const items = root.contexts.map(objectValue)
  if (items.some(item => !item || typeof item.original_sentence !== 'string' || typeof item.meaning_in_context !== 'string' || typeof item.english_definition !== 'string')) return undefined
  return items as Record<string, JsonValue>[]
}
export function mergeEntry(existing: JsonValue | undefined, candidate: JsonValue): CoreResult<JsonValue> {
  if (existing === undefined) return { ok: true, value: cloneJson(candidate) }
  const oldRows = contexts(existing); const newRows = contexts(candidate)
  if (!oldRows || !newRows || objectValue(existing)!.lemma !== objectValue(candidate)!.lemma) return { ok: false, error: { code: 'unrecognized-entry', message: '词条结构无法自动合并，请在完整 JSON 中手工整理。' } }
  const merged = cloneJson(existing) as Record<string, JsonValue>
  const rows = cloneJson(oldRows)
  const positions = new Map(rows.map((row, index) => [row.original_sentence, index]))
  for (const row of newRows) {
    const index = positions.get(row.original_sentence)
    if (index === undefined) { positions.set(row.original_sentence, rows.length); rows.push(cloneJson(row)); continue }
    // 同句保留人工写过的释义，只补空白字段；新值不得覆盖已有内容。
    for (const key of ['meaning_in_context', 'english_definition'] as const) {
      const current = rows[index][key]; const fresh = row[key]
      if (typeof current === 'string' && !current.trim() && typeof fresh === 'string' && fresh.trim()) rows[index][key] = fresh
    }
  }
  merged.contexts = rows
  // 已有词条缺发音信息时补上；不覆盖已有值。
  const fresh = objectValue(candidate)!
  for (const key of ['ipa', 'audio'] as const) {
    const current = merged[key]; const value = fresh[key]
    if ((current === undefined || current === '') && typeof value === 'string' && value.trim()) merged[key] = value
  }
  return { ok: true, value: merged }
}
export function locateContext(value: JsonValue, sentence?: string): { context?: Record<string, JsonValue>; message?: string } {
  const rows = contexts(value)
  if (!rows) return { message: '自定义或旧结构无法识别当前上下文；请查看完整 JSON。' }
  if (!sentence) return { message: '当前原句不可用，无法匹配上下文。' }
  const matches = rows.filter(row => row.original_sentence === sentence)
  return matches.length === 1 ? { context: matches[0] } : { message: matches.length ? '有多个匹配的上下文，请检查完整 JSON。' : '当前标记原句没有匹配的上下文；历史原句保持原值。' }
}
