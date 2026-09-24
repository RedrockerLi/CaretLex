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
  sentence: string
}

export interface WorkspaceTab {
  id: string
  document: DocumentResult
  mode: 'read' | 'source'
  draft: string
  dirty: boolean
  externalConflict: boolean
  pendingExternal?: DocumentResult
}

export type PendingAction =
  | { kind: 'close-tab'; tabId: string }
  | { kind: 'switch-mode'; tabId: string; mode: 'read' }
  | { kind: 'close-window' }
