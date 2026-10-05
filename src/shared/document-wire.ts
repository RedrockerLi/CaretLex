import type { DocumentResult } from './bridge'
import type { DocumentSnapshot, ParsedDocument } from './types'
export interface LocalDocument { snapshot: DocumentSnapshot; parsed: ParsedDocument; error?: string }
/** contextBridge accepts ordinary data. Map indices cross IPC as explicit entry arrays. */
export function documentToWire(value: LocalDocument): DocumentResult {
  return { snapshot: value.snapshot, parsed: { ...value.parsed, entries: [...value.parsed.entries] }, ...(value.error ? { error: value.error } : {}) }
}
export function documentFromWire(value: DocumentResult): LocalDocument {
  return { ...value, parsed: { ...value.parsed, entries: new Map(value.parsed.entries) } }
}
