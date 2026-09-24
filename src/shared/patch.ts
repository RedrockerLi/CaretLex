import {
  getAdjacentVocabularyReference,
  getLineEnding,
  isValidLemma,
  parseDocument,
  validateSelection
} from './protocol'
import type { CoreResult, JsonValue, ParsedDocument, PatchPlan, SourcePatch, SourceSpan } from './types'

export interface AddVocabularyInput {
  span: SourceSpan
  selected: string
  lemma: string
  value: JsonValue
}

export interface EditVocabularyInput {
  lemma: string
  value: JsonValue
}

export interface DeleteVocabularyInput {
  lemma: string
}

function fail<T = never>(code: string, message: string, span?: SourceSpan): CoreResult<T> {
  return { ok: false, error: { code, message, ...(span ? { span } : {}) } }
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) return false
    seen.add(value)
    if (Object.getOwnPropertySymbols(value).length !== 0) return false
    if (Object.getOwnPropertyNames(value).some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) return false
    if (Object.keys(value).length !== value.length) return false
    for (let i = 0; i < value.length; i++) {
      if (!(i in value) || !isJsonValue(value[i], seen)) return false
    }
    seen.delete(value)
    return true
  }
  if (typeof value === 'object') {
    const object = value as object
    if (seen.has(object)) return false
    const prototype = Object.getPrototypeOf(object)
    if (prototype !== Object.prototype && prototype !== null) return false
    if (Object.getOwnPropertySymbols(object).length !== 0) return false
    seen.add(object)
    const valid = Object.entries(Object.getOwnPropertyDescriptors(object)).every(([key, descriptor]) =>
      descriptor.enumerable && !descriptor.get && !descriptor.set && isJsonValue((value as Record<string, unknown>)[key], seen)
    )
    seen.delete(object)
    return valid
  }
  return false
}

function serializeJson(value: unknown): string | undefined {
  try {
    if (!isJsonValue(value)) return undefined
    const result = JSON.stringify(value)
    return typeof result === 'string' ? result : undefined
  } catch {
    return undefined
  }
}

function sourceOffset(text: string, offset: number): number {
  return text.startsWith('\uFEFF') ? offset + 1 : offset
}

function mergeSameOffsetInsertions(patches: SourcePatch[]): SourcePatch[] {
  const sorted = [...patches].sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end)
  const merged: SourcePatch[] = []
  for (const patch of sorted) {
    const prior = merged[merged.length - 1]
    if (prior && prior.span.start === patch.span.start && prior.span.end === patch.span.end && patch.span.start === patch.span.end) {
      prior.replacement += patch.replacement
    } else {
      merged.push({ span: { ...patch.span }, replacement: patch.replacement })
    }
  }
  return merged
}

function applyPatches(text: string, patches: SourcePatch[]): string | undefined {
  const ordered = mergeSameOffsetInsertions(patches)
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].span.start < ordered[i - 1].span.end) return undefined
  }
  let output = text
  for (const patch of [...ordered].sort((left, right) => right.span.start - left.span.start)) {
    const start = sourceOffset(text, patch.span.start)
    const end = sourceOffset(text, patch.span.end)
    output = output.slice(0, start) + patch.replacement + output.slice(end)
  }
  return output
}

function planFromPatches(text: string, patches: SourcePatch[]): CoreResult<PatchPlan> {
  const merged = mergeSameOffsetInsertions(patches)
  const nextText = applyPatches(text, merged)
  if (nextText === undefined) return fail('overlapping-patches', '生成的源码补丁发生重叠，已取消写入。')
  return { ok: true, value: { text: nextText, changed: nextText !== text, patches: merged } }
}

function documentWritable(parsed: ParsedDocument): CoreResult<true> {
  if (parsed.writable) return { ok: true, value: true }
  const diagnostic = parsed.diagnostics.find((item) => item.severity === 'error')
  return fail(
    'document-not-writable',
    diagnostic?.message ?? '文档的托管词条结构无法安全验证，请先在源码中修复。',
    diagnostic?.span
  )
}

function contentForDefinitions(
  parsed: ParsedDocument,
  overrides: Map<string, JsonValue> = new Map(),
  removed = new Set<string>()
): string {
  const values = new Map<string, JsonValue>()
  for (const [lemma, entry] of parsed.entries) {
    if (entry.managed && !removed.has(lemma)) values.set(lemma, overrides.get(lemma) ?? entry.value)
  }
  for (const [lemma, value] of overrides) {
    if (!removed.has(lemma)) values.set(lemma, value)
  }
  const eol = getLineEnding(parsed.text)
  const rows = [...values.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([lemma, value]) => `[^w-${lemma}]: ${JSON.stringify(value)}`)
  return rows.length ? `${rows.join(eol)}${eol}` : ''
}

function blockPatchOrAppend(parsed: ParsedDocument, content: string): SourcePatch {
  if (parsed.managedBlock.present && parsed.managedBlock.contentSpan) {
    return { span: parsed.managedBlock.contentSpan, replacement: content }
  }
  const eol = getLineEnding(parsed.text)
  const source = parsed.text.startsWith('\uFEFF') ? parsed.text.slice(1) : parsed.text
  const suffix = source.endsWith('\r\n') ? '\r\n' : source.endsWith('\n') ? '\n' : source.endsWith('\r') ? '\r' : ''
  const separator = source.length === 0 ? '' : suffix === '' ? eol + eol : source.endsWith(suffix + suffix) ? '' : eol
  const block = `${separator}<!-- caretlex:vocab:start -->${eol}${content}<!-- caretlex:vocab:end -->${eol}`
  return { span: { start: source.length, end: source.length }, replacement: block }
}

function definitionConflict(parsed: ParsedDocument, lemma: string): CoreResult<true> | undefined {
  const identifier = `w-${lemma}`
  const definitions = parsed.footnoteDefinitions.filter((definition) => definition.identifier === identifier)
  if (definitions.length > 1) return fail('duplicate-definition', `词条标签 ${identifier} 有重复定义。`, definitions[1].span)
  const record = parsed.entries.get(lemma)
  if (record) {
    if (!record.managed) return fail('outside-definition', `词条 ${lemma} 的定义位于托管区块外，只能阅读，不能接管。`, record.definitionSpan)
    return { ok: true, value: true }
  }
  if (definitions.length === 1) {
    const definition = definitions[0]
    return fail(
      'conflicting-definition',
      `文档已有归一化后同名的脚注 ${definition.label}，请先在源码中处理该定义。`,
      definition.span
    )
  }
  return undefined
}

export function planAdd(text: string, input: AddVocabularyInput): CoreResult<PatchPlan> {
  if (!isValidLemma(input.lemma)) return fail('invalid-lemma', 'lemma 必须符合小写 ASCII 字母、撇号和连字符规则。')
  const serialized = serializeJson(input.value)
  if (serialized === undefined) return fail('invalid-json-value', '词条必须是可序列化的完整 JSON 值。')
  const selection = validateSelection(text, input.span, input.selected)
  if (!selection.ok) return selection

  const parsed = parseDocument(text)
  const writable = documentWritable(parsed)
  if (!writable.ok) return writable

  const adjacent = getAdjacentVocabularyReference(parsed, input.span)
  if (adjacent) {
    if (adjacent.label === `w-${input.lemma}`) return { ok: true, value: { text, changed: false, patches: [] } }
    return fail('existing-vocabulary-reference', '这个词形后已有另一条词条引用，请先处理现有引用。', adjacent.span)
  }

  const conflict = definitionConflict(parsed, input.lemma)
  if (conflict && !conflict.ok) return conflict
  const existing = parsed.entries.get(input.lemma)
  const patches: SourcePatch[] = [
    { span: { start: input.span.end, end: input.span.end }, replacement: `[^w-${input.lemma}]` }
  ]
  if (existing && !existing.managed) {
    return fail('outside-definition', `词条 ${input.lemma} 的定义位于托管区块外，只能阅读，不能接管。`, existing.definitionSpan)
  }
  const content = contentForDefinitions(parsed, existing ? new Map() : new Map([[input.lemma, input.value]]))
  patches.push(blockPatchOrAppend(parsed, content))
  return planFromPatches(text, patches)
}

export function planEdit(text: string, input: EditVocabularyInput): CoreResult<PatchPlan> {
  if (!isValidLemma(input.lemma)) return fail('invalid-lemma', 'lemma 必须符合首版词条标签规则。')
  if (serializeJson(input.value) === undefined) return fail('invalid-json-value', '词条必须是可序列化的完整 JSON 值。')
  const parsed = parseDocument(text)
  const writable = documentWritable(parsed)
  if (!writable.ok) return writable
  const entry = parsed.entries.get(input.lemma)
  if (!entry) return fail('missing-entry', `文档中没有有效词条 ${input.lemma}。`)
  if (!entry.managed) return fail('outside-definition', `词条 ${input.lemma} 位于托管区块外，只能阅读，不能编辑。`, entry.definitionSpan)
  const content = contentForDefinitions(parsed, new Map([[input.lemma, input.value]]))
  return planFromPatches(text, [{ span: parsed.managedBlock.contentSpan!, replacement: content }])
}

export function planDelete(text: string, input: DeleteVocabularyInput): CoreResult<PatchPlan> {
  if (!isValidLemma(input.lemma)) return fail('invalid-lemma', 'lemma 必须符合首版词条标签规则。')
  const parsed = parseDocument(text)
  const writable = documentWritable(parsed)
  if (!writable.ok) return writable
  const entry = parsed.entries.get(input.lemma)
  if (!entry) return fail('missing-entry', `文档中没有有效词条 ${input.lemma}。`)
  if (!entry.managed) return fail('outside-definition', `词条 ${input.lemma} 位于托管区块外，只能阅读，不能删除。`, entry.definitionSpan)
  const patches: SourcePatch[] = entry.referenceSpans.map((span) => ({ span, replacement: '' }))
  patches.push({
    span: parsed.managedBlock.contentSpan!,
    replacement: contentForDefinitions(parsed, new Map(), new Set([input.lemma]))
  })
  return planFromPatches(text, patches)
}

export function exportVocabulary(text: string): CoreResult<string> {
  const parsed = parseDocument(text)
  const writable = documentWritable(parsed)
  if (!writable.ok) return writable
  const result: Record<string, JsonValue> = Object.create(null)
  for (const [lemma, entry] of [...parsed.entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (entry.managed) result[lemma] = entry.value
  }
  return { ok: true, value: JSON.stringify(result) }
}
