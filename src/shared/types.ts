import type { Root } from 'mdast'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** UTF-16 offsets, left inclusive/right exclusive, measured after an optional BOM. */
export interface SourceSpan {
  start: number
  end: number
}

export interface Diagnostic {
  code: string
  message: string
  severity: 'error' | 'warning'
  span?: SourceSpan
}

export interface DocumentSnapshot {
  id: string
  path?: string
  text: string
  revision?: string
  bom: boolean
  eol: '\n' | '\r\n' | '\r'
}

export interface VocabRecord {
  lemma: string
  value: JsonValue
  /** Full footnote definition range. */
  definitionSpan: SourceSpan
  /** JSON value only, excluding horizontal whitespace after the colon. */
  valueSpan: SourceSpan
  referenceSpans: SourceSpan[]
  managed: boolean
}

export interface TextRun {
  /** Source range of one mdast Text node. */
  sourceSpan: SourceSpan
  value: string
  /** Ancestor mdast node names, from the root down to this Text node's parent. */
  ancestorTypes: string[]
  /** Visible UTF-16 boundary -> source UTF-16 boundary; null means ambiguous. */
  boundaries: Array<number | null>
  mappable: boolean
}

export interface FootnoteReferenceRecord {
  identifier: string
  label?: string
  span: SourceSpan
}

export interface FootnoteDefinitionRecord {
  identifier: string
  label: string
  span: SourceSpan
  valueSpan: SourceSpan
  managed: boolean
  singleLine: boolean
  jsonValid: boolean
  value?: JsonValue
}

export interface ManagedBlock {
  present: boolean
  valid: boolean
  startMarkerSpan?: SourceSpan
  endMarkerSpan?: SourceSpan
  /** Content between the newline after the start marker and the end-marker line. */
  contentSpan?: SourceSpan
  fullSpan?: SourceSpan
}

export interface ParsedDocument {
  text: string
  tree: Root
  entries: Map<string, VocabRecord>
  diagnostics: Diagnostic[]
  managedBlock: ManagedBlock
  writable: boolean
  textRuns: TextRun[]
  footnoteReferences: FootnoteReferenceRecord[]
  footnoteDefinitions: FootnoteDefinitionRecord[]
}

export interface CoreError {
  code: string
  message: string
  span?: SourceSpan
}

export type CoreResult<T> = { ok: true; value: T } | { ok: false; error: CoreError }

export interface SourcePatch {
  span: SourceSpan
  replacement: string
}

export interface PatchPlan {
  text: string
  changed: boolean
  patches: SourcePatch[]
}

export interface MappingResult {
  ok: true
  span: SourceSpan
  selected: string
}

export interface MappingFailure {
  ok: false
  reason: string
}

export type SelectionResult = CoreResult<{ span: SourceSpan; selected: string }>

export type MdastRoot = Root
