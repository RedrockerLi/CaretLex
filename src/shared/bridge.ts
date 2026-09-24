import type { DocumentSnapshot, JsonValue, ParsedDocument, SourceSpan } from './types'
import type { AppSettings } from './settings'

export interface DocumentResult {
  snapshot: DocumentSnapshot
  parsed: ParsedDocument
}

export interface SaveResult extends DocumentResult {
  changed: boolean
}

export interface SettingsSnapshot {
  value: AppSettings
  revision: string
  path: string
  error?: string
}

export type DocumentChangedEvent = {
  documentId: string
  document: DocumentResult
}

export interface CaretLexBridge {
  takeStartupDocument(): Promise<DocumentResult | null>
  openMarkdown(): Promise<DocumentResult | null>
  newDocument(): Promise<DocumentResult>
  closeDocument(documentId: string): Promise<void>
  saveSource(input: { documentId: string; baseRevision?: string; text: string }): Promise<SaveResult | null>
  saveAs(input: { documentId: string; baseRevision?: string; text: string }): Promise<SaveResult | null>
  addVocabulary(input: {
    documentId: string
    baseRevision?: string
    sourceSpan: SourceSpan
    selected: string
    lemma: string
    value: JsonValue
  }): Promise<SaveResult>
  editVocabulary(input: { documentId: string; baseRevision?: string; lemma: string; value: JsonValue }): Promise<SaveResult>
  deleteVocabulary(input: { documentId: string; baseRevision?: string; lemma: string }): Promise<SaveResult>
  exportCurrentVocabulary(documentId: string): Promise<{ kind: 'saved'; path: string } | { kind: 'cancelled' }>
  loadSettings(): Promise<SettingsSnapshot>
  saveSettings(input: { value: unknown; baseRevision?: string }): Promise<SettingsSnapshot>
  chooseSettingsPath(): Promise<SettingsSnapshot | null>
  openExternal(url: string): Promise<void>
  loadLocalImage(documentId: string, source: string): Promise<string | null>
  loadRemoteImage(url: string): Promise<string | null>
  onDocumentChanged(callback: (event: DocumentChangedEvent) => void): () => void
  onSettingsChanged(callback: (snapshot: SettingsSnapshot) => void): () => void
  onRequestClose(callback: () => void): () => void
  respondToClose(allow: boolean): void
  showError(message: string): Promise<void>
}
