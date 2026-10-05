import type { CaretLexBridge, DocumentResult, SaveResult, SettingsSnapshot } from '../shared/bridge'
import type { JsonValue, ParsedDocument, SourceSpan, VocabRecord } from '../shared/types'

declare global {
  interface Window {
    caretlex: CaretLexBridge
  }
}

export type { CaretLexBridge, DocumentResult, JsonValue, ParsedDocument, SaveResult, SettingsSnapshot, SourceSpan, VocabRecord }

export interface SelectionContext {
  sourceSpan: SourceSpan
  selected: string
  documentId: string
  baseRevision?: string
}

export interface WorkspaceDocument extends Omit<DocumentResult, 'parsed'> { parsed: ParsedDocument }

export interface WorkspaceTab {
  id: string
  document: WorkspaceDocument
  mode: 'read' | 'source'
  draft: string
  dirty: boolean
  externalConflict: boolean
  pendingExternal?: WorkspaceDocument
}

export type PendingAction =
  | { kind: 'close-tab'; tabId: string }
  | { kind: 'switch-mode'; tabId: string; mode: 'read' }
  | { kind: 'close-window' }
