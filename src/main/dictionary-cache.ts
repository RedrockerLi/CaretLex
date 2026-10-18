import { DatabaseSync } from 'node:sqlite'
import type { DictionaryCacheStats } from '../shared/bridge'
import type { DictionaryLookup } from '../shared/dictionary'

const PRODUCT = 'learners'
// 2：候选新增 audio 字段；旧行缺少发音信息，打开时清理后按需重抓。
const SCHEMA_VERSION = 2

function isLookup(value: unknown): value is DictionaryLookup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.query !== 'string' || typeof record.fetchedAt !== 'number' || !Array.isArray(record.candidates)) return false
  return record.candidates.every(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const entry = candidate as Record<string, unknown>
    if (typeof entry.entryId !== 'string' || typeof entry.lemma !== 'string' || !Array.isArray(entry.senses)) return false
    return entry.senses.every(sense => {
      if (!sense || typeof sense !== 'object' || Array.isArray(sense)) return false
      const item = sense as Record<string, unknown>
      return typeof item.id === 'string' && typeof item.definition === 'string'
        && Array.isArray(item.examples) && item.examples.every(example => typeof example === 'string')
    })
  })
}

export class DictionaryCache {
  private db?: DatabaseSync
  constructor(private readonly path: string) {
    try {
      this.db = new DatabaseSync(path)
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA busy_timeout = 1000')
      this.db.exec(`CREATE TABLE IF NOT EXISTS lookups (
        query TEXT NOT NULL,
        product TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (query, product, schema_version)
      )`)
      this.db.prepare('DELETE FROM lookups WHERE product = ? AND schema_version <> ?').run(PRODUCT, SCHEMA_VERSION)
    } catch {
      this.db = undefined
    }
  }
  private get available(): boolean { return this.db !== undefined }
  get(query: string): DictionaryLookup | undefined { return this.read(query, false) }
  getStale(query: string): DictionaryLookup | undefined { return this.read(query, true) }
  private read(query: string, stale: boolean): DictionaryLookup | undefined {
    if (!this.db) return undefined
    try {
      const row = this.db.prepare('SELECT payload, expires_at FROM lookups WHERE query = ? AND product = ? AND schema_version = ?').get(query, PRODUCT, SCHEMA_VERSION) as Record<string, unknown> | undefined
      if (!row || typeof row.payload !== 'string') return undefined
      if (!stale && typeof row.expires_at === 'number' && row.expires_at <= Date.now()) return undefined
      const parsed: unknown = JSON.parse(row.payload)
      if (!isLookup(parsed)) { this.remove(query); return undefined }
      return parsed
    } catch { this.remove(query); return undefined }
  }
  put(query: string, lookup: DictionaryLookup, ttlMs: number | null): void {
    if (!this.db) return
    try {
      const now = Date.now()
      const expiresAt = ttlMs === null ? null : now + ttlMs
      this.db.prepare(`INSERT INTO lookups (query, product, schema_version, payload, fetched_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(query, product, schema_version) DO UPDATE SET
          payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`
      ).run(query, PRODUCT, SCHEMA_VERSION, JSON.stringify(lookup), now, expiresAt)
    } catch { /* cache is best-effort */ }
  }
  clear(): void {
    if (!this.db) return
    try { this.db.exec('DELETE FROM lookups'); this.db.exec('VACUUM') } catch { /* best-effort */ }
  }
  stats(): DictionaryCacheStats {
    if (!this.db) return { entries: 0, bytes: 0, available: false }
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS bytes FROM lookups WHERE product = ? AND schema_version = ?').get(PRODUCT, SCHEMA_VERSION) as Record<string, unknown> | undefined
      return { entries: Number(row?.entries ?? 0), bytes: Number(row?.bytes ?? 0), available: true }
    } catch { return { entries: 0, bytes: 0, available: false } }
  }
  close(): void {
    try { this.db?.close() } catch { /* best-effort */ }
    this.db = undefined
  }
  private remove(query: string): void {
    try { this.db?.prepare('DELETE FROM lookups WHERE query = ? AND product = ? AND schema_version = ?').run(query, PRODUCT, SCHEMA_VERSION) } catch { /* best-effort */ }
  }
}
