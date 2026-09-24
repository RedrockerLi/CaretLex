import { decodeString } from 'micromark-util-decode-string'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type {
  Diagnostic,
  FootnoteDefinitionRecord,
  FootnoteReferenceRecord,
  JsonValue,
  ManagedBlock,
  MappingFailure,
  MappingResult,
  ParsedDocument,
  SelectionResult,
  SourceSpan,
  TextRun,
  VocabRecord
} from './types'

interface MdNode {
  type: string
  value?: unknown
  identifier?: unknown
  label?: unknown
  position?: {
    start?: { offset?: number; line?: number; column?: number }
    end?: { offset?: number; line?: number; column?: number }
  }
  children?: MdNode[]
}

interface PhysicalLine {
  start: number
  contentEnd: number
  end: number
  value: string
}

interface DefinitionInfo {
  node?: MdNode
  label: string
  identifier: string
  span: SourceSpan
  valueSpan: SourceSpan
  managed: boolean
  singleLine: boolean
  value?: JsonValue
  jsonValid: boolean
  strictLemma?: string
  line: PhysicalLine
}

function unwrapDefaultPlugin<T>(plugin: T): T {
  if (plugin && typeof plugin === 'object' && 'default' in plugin) {
    return (plugin as { default: T }).default
  }
  return plugin
}

const processor = unified().use(unwrapDefaultPlugin(remarkParse)).use(unwrapDefaultPlugin(remarkGfm))
const startMarker = '<!-- caretlex:vocab:start -->'
const endMarker = '<!-- caretlex:vocab:end -->'
const lemmaPattern = /^[a-z]+(?:['-][a-z]+)*$/
const definitionHeadPattern = /^ {0,3}\[\^([^\]\r\n]+)\]:[\t ]*/
const blockDefinitionPattern = /^ {0,3}\[\^([^\]\r\n]+)\]:[\t ]*(.*?)[\t ]*$/
const disallowedTextAncestors = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'html',
  'footnoteDefinition',
  'footnoteReference',
  'definition',
  'yaml',
  'toml',
  'math',
  'inlineMath'
])

function getOffset(node: MdNode, edge: 'start' | 'end', lineStarts: number[]): number | undefined {
  const point = node.position?.[edge]
  if (!point) return undefined
  if (typeof point.offset === 'number') return point.offset
  if (typeof point.line === 'number' && typeof point.column === 'number') {
    const lineStart = lineStarts[point.line - 1]
    if (lineStart !== undefined) return lineStart + point.column - 1
  }
  return undefined
}

function makeLines(text: string): PhysicalLine[] {
  const lines: PhysicalLine[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n' || text[i] === '\r') {
      const contentEnd = i
      if (text[i] === '\r' && text[i + 1] === '\n') i++
      const end = i + 1
      lines.push({ start, contentEnd, end, value: text.slice(start, contentEnd) })
      start = end
    }
  }
  lines.push({ start, contentEnd: text.length, end: text.length, value: text.slice(start) })
  return lines
}

function lineAt(lines: PhysicalLine[], offset: number): PhysicalLine {
  let low = 0
  let high = lines.length - 1
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (lines[mid].start <= offset) low = mid
    else high = mid - 1
  }
  return lines[low]
}

function lineIndexAt(lines: PhysicalLine[], offset: number): number {
  let low = 0
  let high = lines.length - 1
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (lines[mid].start <= offset) low = mid
    else high = mid - 1
  }
  return low
}

function normalizeIdentifier(label: string): string {
  return label.trim().replace(/[\t\n\r ]+/g, ' ').toLowerCase()
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isJsonValue)
  }
  return false
}

function walk(node: MdNode, ancestors: string[], visit: (node: MdNode, ancestors: string[]) => void): void {
  visit(node, ancestors)
  for (const child of node.children ?? []) walk(child, [...ancestors, node.type], visit)
}

function makeTextRun(text: string, node: MdNode, ancestors: string[], span: SourceSpan): TextRun {
  const raw = text.slice(span.start, span.end)
  const boundaries: Array<number | null> = [span.start]
  let visible = ''
  let index = 0

  while (index < raw.length) {
    const sourceStart = span.start + index
    let sourceEnd: number
    let piece: string
    const current = raw[index]

    if (current === '\\' && index + 1 < raw.length && /[!-/:-@[-`{-~]/.test(raw[index + 1])) {
      piece = raw[index + 1]
      sourceEnd = sourceStart + 2
      index += 2
    } else if (current === '&') {
      const rest = raw.slice(index)
      const match = /^&(?:#[xX][0-9a-fA-F]+;?|#\d+;?|[A-Za-z][A-Za-z\d]+;)/.exec(rest)
      const decoded = match ? decodeString(match[0]) : ''
      if (match && decoded !== match[0]) {
        piece = decoded
        sourceEnd = sourceStart + match[0].length
        index += match[0].length
      } else {
        const cp = raw.codePointAt(index)!
        piece = String.fromCodePoint(cp)
        sourceEnd = sourceStart + piece.length
        index += piece.length
      }
    } else if (current === '\r' && raw[index + 1] === '\n') {
      piece = '\n'
      sourceEnd = sourceStart + 2
      index += 2
    } else {
      const cp = raw.codePointAt(index)!
      piece = String.fromCodePoint(cp)
      sourceEnd = sourceStart + piece.length
      index += piece.length
    }

    visible += piece
    if (piece.length === 1) {
      boundaries.push(sourceEnd)
    } else {
      for (let n = 1; n < piece.length; n++) boundaries.push(null)
      boundaries.push(sourceEnd)
    }
  }

  const value = typeof node.value === 'string' ? node.value : ''
  const mappable = visible === value && boundaries.length === value.length + 1
  return {
    sourceSpan: span,
    value,
    ancestorTypes: ancestors,
    boundaries: mappable ? boundaries : Array(value.length + 1).fill(null),
    mappable
  }
}

function parseDefinitionLine(
  line: PhysicalLine,
  span: SourceSpan,
  node: MdNode | undefined,
  managed: boolean,
  text: string
): DefinitionInfo | undefined {
  const head = definitionHeadPattern.exec(line.value)
  if (!head) return undefined
  const blockMatch = blockDefinitionPattern.exec(line.value)
  const label = head[1]
  const labelEnd = line.value.indexOf(']')
  const colonIndex = labelEnd + 1
  const bodyStart = colonIndex + 1 + (line.value.slice(colonIndex + 1).match(/^[\t ]*/)![0].length)
  const bodyEnd = line.value.slice(bodyStart).replace(/[\t ]+$/, '').length + bodyStart
  const valueText = line.value.slice(bodyStart, bodyEnd)
  const valueSpan = { start: line.start + bodyStart, end: line.start + bodyEnd }
  let value: JsonValue | undefined
  let jsonValid = false
  try {
    const parsed: unknown = JSON.parse(valueText)
    if (isJsonValue(parsed)) {
      value = parsed
      jsonValid = true
    }
  } catch {
    // Invalid definition bodies remain ordinary footnotes outside a managed block.
  }
  const nodeStart = node?.position?.start?.offset
  const nodeEnd = node?.position?.end?.offset
  const singleLine = Boolean(
    node && nodeStart !== undefined && nodeEnd !== undefined && nodeStart >= line.start && nodeStart <= line.contentEnd && nodeEnd <= line.contentEnd
  )
  const rawLabel = String(node?.label ?? label)
  const match = /^w-([a-z]+(?:['-][a-z]+)*)$/.exec(rawLabel)
  return {
    node,
    label: rawLabel,
    identifier: normalizeIdentifier(String(node?.identifier ?? label)),
    span,
    valueSpan,
    managed,
    singleLine: singleLine && Boolean(blockMatch),
    ...(value === undefined ? {} : { value }),
    jsonValid,
    ...(match ? { strictLemma: match[1] } : {}),
    line
  }
}

function addDiagnostic(
  diagnostics: Diagnostic[],
  code: string,
  message: string,
  span?: SourceSpan,
  severity: 'error' | 'warning' = 'error'
): void {
  diagnostics.push({ code, message, severity, ...(span ? { span } : {}) })
}

function nodeContainsSpan(node: MdNode, start: number, end: number, lineStarts: number[]): boolean {
  const nodeStart = getOffset(node, 'start', lineStarts)
  const nodeEnd = getOffset(node, 'end', lineStarts)
  return nodeStart !== undefined && nodeEnd !== undefined && nodeStart <= start && nodeEnd >= end
}

function parseManagedBlock(
  source: string,
  lines: PhysicalLine[],
  root: MdNode,
  lineStarts: number[],
  diagnostics: Diagnostic[]
): ManagedBlock {
  const topLevelHtml = (root.children ?? []).filter((node) => node.type === 'html')
  const starts: PhysicalLine[] = []
  const ends: PhysicalLine[] = []
  for (const line of lines) {
    if (line.value !== startMarker && line.value !== endMarker) continue
    const isRootHtml = topLevelHtml.some((node) => nodeContainsSpan(node, line.start, line.contentEnd, lineStarts))
    if (!isRootHtml) continue
    if (line.value === startMarker) starts.push(line)
    else ends.push(line)
  }

  if (starts.length === 0 && ends.length === 0) {
    return { present: false, valid: true }
  }

  let valid = true
  const firstMarker = starts[0] ?? ends[0]
  if (starts.length !== 1 || ends.length !== 1) {
    valid = false
    addDiagnostic(
      diagnostics,
      'managed-block-markers',
      '托管区块标记缺失或重复；请在源码中修复后再操作词条。',
      { start: firstMarker.start, end: firstMarker.contentEnd }
    )
  }
  if (starts.length !== 1 || ends.length !== 1) return { present: true, valid: false }

  const startLine = starts[0]
  const endLine = ends[0]
  if (startLine.start >= endLine.start) {
    valid = false
    addDiagnostic(diagnostics, 'managed-block-order', '托管区块结束标记必须位于开始标记之后。', {
      start: startLine.start,
      end: endLine.contentEnd
    })
  }
  const afterEnd = source.slice(endLine.end)
  if (afterEnd.trim() !== '') {
    valid = false
    addDiagnostic(diagnostics, 'managed-block-not-at-end', '托管区块结束标记后只能有空白。', {
      start: endLine.end,
      end: source.length
    })
  }
  if (startLine.end === startLine.contentEnd) {
    valid = false
    addDiagnostic(diagnostics, 'managed-block-line', '托管区块开始标记必须独占一行并以换行结束。', {
      start: startLine.start,
      end: startLine.contentEnd
    })
  }

  const contentSpan = { start: startLine.end, end: endLine.start }
  const fullSpan = { start: startLine.start, end: endLine.end }
  const managed: ManagedBlock = {
    present: true,
    valid,
    startMarkerSpan: { start: startLine.start, end: startLine.contentEnd },
    endMarkerSpan: { start: endLine.start, end: endLine.contentEnd },
    contentSpan,
    fullSpan
  }

  if (!valid) return managed

  // Every non-empty physical line in the managed zone must be a parser-confirmed,
  // one-line w- definition. Raw line checks keep duplicate and malformed rows visible.
  const astDefinitions: MdNode[] = []
  for (const child of root.children ?? []) {
    walk(child, ['root'], (node) => {
      if (node.type === 'footnoteDefinition') astDefinitions.push(node)
    })
  }
  for (const line of lines) {
    if (line.start < contentSpan.start || line.start >= contentSpan.end) continue
    if (line.value.trim() === '') continue
    const match = blockDefinitionPattern.exec(line.value)
    const ast = astDefinitions.find((node) => {
      const start = getOffset(node, 'start', lineStarts)
      return start !== undefined && start >= line.start && start < line.contentEnd
    })
    if (!match || !ast) {
      managed.valid = false
      valid = false
      addDiagnostic(diagnostics, 'managed-block-content', '托管区块中包含非脚注定义内容。', {
        start: line.start,
        end: line.contentEnd
      })
      continue
    }
    const label = String(ast.label ?? match[1])
    if (!/^w-[a-z]+(?:['-][a-z]+)*$/.test(label)) {
      managed.valid = false
      valid = false
      addDiagnostic(diagnostics, 'managed-block-label', '托管区块标签必须符合 w-lemma 格式。', {
        start: line.start,
        end: line.contentEnd
      })
      continue
    }
    const span = {
      start: getOffset(ast, 'start', lineStarts) ?? line.start,
      end: getOffset(ast, 'end', lineStarts) ?? line.contentEnd
    }
    const def = parseDefinitionLine(line, span, ast, true, source)
    if (!def?.singleLine || !def.jsonValid) {
      managed.valid = false
      valid = false
      addDiagnostic(
        diagnostics,
        'managed-block-json',
        '托管定义必须在单行内包含一个完整、合法的 JSON 值。',
        { start: line.start, end: line.contentEnd }
      )
    }
  }

  managed.valid = valid
  return managed
}

export function isValidLemma(lemma: string): boolean {
  return lemmaPattern.test(lemma)
}

export function parseDocument(text: string): ParsedDocument {
  const bom = text.startsWith('\uFEFF')
  const source = bom ? text.slice(1) : text
  const root = processor.parse(source) as unknown as MdNode
  const rootTyped = root as unknown as ParsedDocument['tree']
  const lines = makeLines(source)
  const lineStarts = lines.map((line) => line.start)
  const diagnostics: Diagnostic[] = []
  const managedBlock = parseManagedBlock(source, lines, root, lineStarts, diagnostics)

  const mdNodes: Array<{ node: MdNode; ancestors: string[] }> = []
  const textRuns: TextRun[] = []
  const footnoteReferences: FootnoteReferenceRecord[] = []
  const astDefinitions: MdNode[] = []
  walk(root, [], (node, ancestors) => {
    mdNodes.push({ node, ancestors })
    const start = getOffset(node, 'start', lineStarts)
    const end = getOffset(node, 'end', lineStarts)
    if (node.type === 'text' && start !== undefined && end !== undefined) {
      textRuns.push(makeTextRun(source, node, ancestors, { start, end }))
    }
    if (node.type === 'footnoteReference' && start !== undefined && end !== undefined) {
      const raw = source.slice(start, end)
      const rawLabel = /^\[\^([^\]]+)\]$/.exec(raw)?.[1]
      footnoteReferences.push({
        identifier: normalizeIdentifier(String(node.identifier ?? rawLabel ?? '')),
        ...(rawLabel ? { label: rawLabel } : typeof node.label === 'string' ? { label: node.label } : {}),
        span: { start, end }
      })
    }
    if (node.type === 'footnoteDefinition') astDefinitions.push(node)
  })

  const blockStart = managedBlock.contentSpan?.start
  const blockEnd = managedBlock.contentSpan?.end
  const definitionNodesByLine = new Map<number, MdNode[]>()
  for (const node of astDefinitions) {
    const start = getOffset(node, 'start', lineStarts)
    if (start === undefined) continue
    const line = lineAt(lines, start)
    const group = definitionNodesByLine.get(line.start) ?? []
    group.push(node)
    definitionNodesByLine.set(line.start, group)
  }

  const definitions: DefinitionInfo[] = []
  const seenRawHeads = new Set<number>()
  const literalLineStarts = new Set<number>()
  for (const { node } of mdNodes) {
    if (node.type !== 'code' && node.type !== 'inlineCode' && node.type !== 'html') continue
    const start = getOffset(node, 'start', lineStarts)
    const end = getOffset(node, 'end', lineStarts)
    if (start === undefined || end === undefined) continue
    for (let index = lineIndexAt(lines, start); index < lines.length && lines[index].start < end; index++) {
      literalLineStarts.add(lines[index].start)
    }
  }
  for (const line of lines) {
    const head = definitionHeadPattern.exec(line.value)
    if (!head) continue
    const candidateStart = line.start + (line.value.length - line.value.trimStart().length)
    const literal = literalLineStarts.has(line.start)
    const matchingAst = (definitionNodesByLine.get(line.start) ?? [])[0]
    if (!matchingAst && literal) continue
    if (!matchingAst && seenRawHeads.has(candidateStart)) continue
    seenRawHeads.add(candidateStart)
    const rawSpan = matchingAst
      ? {
          start: getOffset(matchingAst, 'start', lineStarts) ?? line.start,
          end: getOffset(matchingAst, 'end', lineStarts) ?? line.contentEnd
        }
      : { start: candidateStart, end: line.contentEnd }
    const inManaged = blockStart !== undefined && blockEnd !== undefined && rawSpan.start >= blockStart && rawSpan.start < blockEnd
    const definition = parseDefinitionLine(line, rawSpan, matchingAst, inManaged, source)
    if (definition) definitions.push(definition)
  }

  const processedDefinitions = new Set<MdNode>()
  for (const line of lines) {
    const node = (definitionNodesByLine.get(line.start) ?? [])[0]
    if (!node) continue
    const start = getOffset(node, 'start', lineStarts)
    const end = getOffset(node, 'end', lineStarts)
    if (start === undefined || end === undefined) continue
    const sourceLine: PhysicalLine = {
      start,
      contentEnd: line.contentEnd,
      end: line.end,
      value: source.slice(start, line.contentEnd)
    }
    const span = { start, end }
    const inManaged = blockStart !== undefined && blockEnd !== undefined && start >= blockStart && start < blockEnd
    const definition = parseDefinitionLine(sourceLine, span, node, inManaged, source)
    if (definition && !definitions.some((item) => item.span.start === span.start)) definitions.push(definition)
    processedDefinitions.add(node)
  }
  for (const node of astDefinitions) {
    if (processedDefinitions.has(node)) continue
    const start = getOffset(node, 'start', lineStarts)
    const end = getOffset(node, 'end', lineStarts)
    if (start === undefined || end === undefined) continue
    const physical = lineAt(lines, start)
    const sourceLine: PhysicalLine = {
      start,
      contentEnd: physical.contentEnd,
      end: physical.end,
      value: source.slice(start, physical.contentEnd)
    }
    const span = { start, end }
    const inManaged = blockStart !== undefined && blockEnd !== undefined && start >= blockStart && start < blockEnd
    const definition = parseDefinitionLine(sourceLine, span, node, inManaged, source)
    if (definition && !definitions.some((item) => item.span.start === span.start)) definitions.push(definition)
  }

  // GFM may expose only its first definition for repeated identifiers. The raw
  // definition pass above also contributes later non-literal heads to this table.
  const wDefinitions = definitions.filter((definition) => /^w-/i.test(definition.label))
  const definitionsByIdentifier = new Map<string, DefinitionInfo[]>()
  for (const definition of wDefinitions) {
    const group = definitionsByIdentifier.get(definition.identifier) ?? []
    group.push(definition)
    definitionsByIdentifier.set(definition.identifier, group)
  }
  const duplicateIdentifiers = new Set<string>()
  for (const [identifier, group] of definitionsByIdentifier) {
    if (group.length > 1) {
      duplicateIdentifiers.add(identifier)
      for (const definition of group) {
        addDiagnostic(
          diagnostics,
          'duplicate-vocab-definition',
          `词条标签 ${definition.label} 有多个定义，无法安全读写。`,
          definition.span
        )
      }
    }
  }

  const entries = new Map<string, VocabRecord>()
  for (const definition of definitions) {
    if (!definition.strictLemma || !definition.jsonValid || definition.value === undefined || !definition.singleLine) {
      if (/^w-/i.test(definition.label) && !definition.managed) {
        const message = !definition.strictLemma
          ? `词条标签 ${definition.label} 不符合 w-lemma 格式，将按普通脚注显示。`
          : `词条定义 ${definition.label} 不是单行合法 JSON，将按普通脚注显示。`
        addDiagnostic(diagnostics, 'invalid-vocab-definition', message, definition.span, 'warning')
      }
      continue
    }
    if (duplicateIdentifiers.has(definition.identifier)) continue
    const lemma = definition.strictLemma
    const refs = footnoteReferences
      .filter((reference) => reference.identifier === definition.identifier && reference.label === definition.label)
      .map((reference) => reference.span)
    entries.set(lemma, {
      lemma,
      value: definition.value,
      definitionSpan: definition.span,
      valueSpan: definition.valueSpan,
      referenceSpans: refs,
      managed: definition.managed
    })
  }

  const footnoteDefinitions: FootnoteDefinitionRecord[] = definitions.map((definition) => ({
    identifier: definition.identifier,
    label: definition.label,
    span: definition.span,
    valueSpan: definition.valueSpan,
    managed: definition.managed,
    singleLine: definition.singleLine,
    jsonValid: definition.jsonValid,
    ...(definition.value === undefined ? {} : { value: definition.value })
  }))

  const duplicateBlocks = diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-vocab-definition')
  const writable = managedBlock.valid && !duplicateBlocks
  if (bom) {
    // Public source ranges exclude the BOM; the renderer and patcher share this rule.
  }
  return {
    text,
    tree: rootTyped,
    entries,
    diagnostics,
    managedBlock,
    writable,
    textRuns,
    footnoteReferences,
    footnoteDefinitions
  }
}

function isSelectableRun(run: TextRun): boolean {
  return run.mappable && !run.ancestorTypes.some((type) => disallowedTextAncestors.has(type))
}

function isSingleWord(value: string): boolean {
  return /^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(value)
}

function hasWordBoundary(value: string, start: number, end: number): boolean {
  const isWordCharacter = (character: string | undefined): boolean => character !== undefined && /[A-Za-z'-]/.test(character)
  return !isWordCharacter(value[start - 1]) && !isWordCharacter(value[end])
}

export function mapVisibleRange(
  parsed: ParsedDocument,
  textNodeSpan: SourceSpan,
  visibleStart: number,
  visibleEnd: number
): MappingResult | MappingFailure {
  const matching = parsed.textRuns.filter(
    (run) => run.sourceSpan.start === textNodeSpan.start && run.sourceSpan.end === textNodeSpan.end
  )
  if (matching.length !== 1) return { ok: false, reason: '无法唯一识别这段显示文字对应的 Markdown 文本节点。' }
  const run = matching[0]
  if (!isSelectableRun(run)) return { ok: false, reason: '该位置位于代码、链接、HTML 或脚注定义中，不能存词。' }
  if (!Number.isInteger(visibleStart) || !Number.isInteger(visibleEnd) || visibleStart < 0 || visibleEnd > run.value.length || visibleEnd <= visibleStart) {
    return { ok: false, reason: '选区边界无效或为空。' }
  }
  const selected = run.value.slice(visibleStart, visibleEnd)
  if (!isSingleWord(selected) || !hasWordBoundary(run.value, visibleStart, visibleEnd)) {
    return { ok: false, reason: '请选择一个完整英文单词。' }
  }
  const start = run.boundaries[visibleStart]
  const end = run.boundaries[visibleEnd]
  if (start === null || end === null || start === undefined || end === undefined) {
    return { ok: false, reason: '转义或实体的边界无法精确定位，请选择边界清楚的单词。' }
  }
  return { ok: true, span: { start, end }, selected }
}

export function validateSelection(text: string, sourceSpan: SourceSpan, selected: string): SelectionResult {
  if (!isSingleWord(selected)) {
    return { ok: false, error: { code: 'invalid-selection', message: '请选择一个完整英文单词。', span: sourceSpan } }
  }
  if (!Number.isInteger(sourceSpan.start) || !Number.isInteger(sourceSpan.end) || sourceSpan.start < 0 || sourceSpan.end <= sourceSpan.start) {
    return { ok: false, error: { code: 'invalid-span', message: '选区源码范围无效。', span: sourceSpan } }
  }
  const parsed = parseDocument(text)
  const matches: SourceSpan[] = []
  for (const run of parsed.textRuns) {
    if (!isSelectableRun(run)) continue
    for (let start = 0; start + selected.length <= run.value.length; start++) {
      if (run.value.slice(start, start + selected.length) !== selected) continue
      if (!hasWordBoundary(run.value, start, start + selected.length)) continue
      const mappedStart = run.boundaries[start]
      const mappedEnd = run.boundaries[start + selected.length]
      if (mappedStart === sourceSpan.start && mappedEnd === sourceSpan.end) {
        matches.push({ start: mappedStart, end: mappedEnd })
      }
    }
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      error: {
        code: 'selection-not-unique',
        message: matches.length === 0 ? '选区与当前 Markdown 文本不匹配或无法精确定位。' : '选区对应多个可见位置，无法安全写入。',
        span: sourceSpan
      }
    }
  }
  return { ok: true, value: { span: sourceSpan, selected } }
}

export function getAdjacentVocabularyReference(
  parsed: ParsedDocument,
  sourceSpan: SourceSpan
): FootnoteReferenceRecord | undefined {
  return parsed.footnoteReferences.find((reference) => reference.span.start === sourceSpan.end && /^w-/i.test(reference.label ?? ''))
}

export function getLineEnding(text: string): '\n' | '\r\n' | '\r' {
  const match = /\r\n|\n|\r/.exec(text)
  return (match?.[0] as '\n' | '\r\n' | '\r' | undefined) ?? '\n'
}
