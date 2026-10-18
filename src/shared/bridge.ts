import type { DocumentSnapshot, JsonValue, ParsedDocument, SourceSpan, VocabRecord } from './types'
import type { AppSettings } from './settings'
import type { ArticleData, ProviderIssue } from './providers'
import type { CoreResult } from './types'
import type { MenuCommand, MenuState } from './menu'

export interface DocumentResult {
  error?: string
  snapshot: DocumentSnapshot
  parsed: Omit<ParsedDocument, 'entries'> & { entries: Array<[string, VocabRecord]> }
}

export interface SaveResult extends DocumentResult {
  changed: boolean
}

export interface SettingsSnapshot {
  resetToken?: string
  value?: AppSettings
  text?: string
  revision: string
  path: string
  error?: string
}

export type DocumentChangedEvent = {
  documentId: string
  document: DocumentResult
}

export interface EntryLocation {
  documentId: string
  baseRevision?: string
  sourceSpan: SourceSpan
  selected: string
}
export interface ProviderFetchInput extends EntryLocation { requestId: string; settingsRevision: string }
export interface SourceResult {
  requestId: string
  article?: ArticleData
  sources: Record<string, JsonValue>
  examples: Record<string, JsonValue>
  issues: ProviderIssue[]
}
export interface ProviderDescription { type: string; defaultConfig: JsonValue; hasPreset: boolean }
export interface DictionaryCacheStats { entries: number; bytes: number; available: boolean }
export interface AudioStats { entries: number; bytes: number; available: boolean }
export interface CaretLexBridge {
  onMenuCommand(callback: (command: MenuCommand) => void): () => void
  updateMenuState(state: MenuState): void
  editHistory(command: 'undo' | 'redo'): Promise<void>
  providerTypes(): Promise<ProviderDescription[]>
  providerPreset(input: { type: string; name: string; config: JsonValue }): Promise<{ template: JsonValue | null; reason?: string }>
  getArticle(input: EntryLocation): Promise<CoreResult<ArticleData>>
  fetchSources(input: ProviderFetchInput): Promise<SourceResult>
  cancelProvider(requestId: string): Promise<void>
  saveCredential(key: string): Promise<string>
  credentialStatus(ref?: string): Promise<{ exists: boolean; masked?: string; error?: string }>
  removeCredential(ref: string): Promise<void>
  dictionaryCacheStats(): Promise<DictionaryCacheStats>
  clearDictionaryCache(): Promise<DictionaryCacheStats>
  loadPronunciation(url: string): Promise<string | null>
  audioStats(): Promise<AudioStats>
  clearAudio(): Promise<AudioStats>
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
  resetSettings(resetToken: string): Promise<SettingsSnapshot>
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
