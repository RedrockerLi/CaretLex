import { DatabaseSync } from 'node:sqlite'
import type { AudioStats } from '../shared/bridge'

export interface StoredAudio { mime: string; bytes: Uint8Array }

const MAX_AUDIO_BYTES = 1024 * 1024

/** 与 DictionaryCache 共用 dictionary.sqlite，但生命周期独立：清空查询缓存不删已保存的发音。 */
export class AudioStore {
  private db?: DatabaseSync
  constructor(path: string) {
    try {
      this.db = new DatabaseSync(path)
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA busy_timeout = 1000')
      this.db.exec(`CREATE TABLE IF NOT EXISTS audio (
        url TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        bytes BLOB NOT NULL,
        size INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL
      )`)
    } catch {
      this.db = undefined
    }
  }
  has(url: string): boolean {
    if (!this.db) return false
    try {
      return !!this.db.prepare('SELECT 1 AS present FROM audio WHERE url = ?').get(url)
    } catch { return false }
  }
  get(url: string): StoredAudio | undefined {
    if (!this.db) return undefined
    try {
      const row = this.db.prepare('SELECT mime, bytes FROM audio WHERE url = ?').get(url) as Record<string, unknown> | undefined
      if (!row || typeof row.mime !== 'string' || !(row.bytes instanceof Uint8Array) || !row.bytes.byteLength) return undefined
      return { mime: row.mime, bytes: row.bytes }
    } catch { return undefined }
  }
  put(url: string, mime: string, bytes: Uint8Array): void {
    if (!this.db || !bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) return
    try {
      this.db.prepare(`INSERT INTO audio (url, mime, bytes, size, fetched_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, size = excluded.size, fetched_at = excluded.fetched_at`
      ).run(url, mime, bytes, bytes.byteLength, Date.now())
    } catch { /* 缓存尽力而为 */ }
  }
  stats(): AudioStats {
    if (!this.db) return { entries: 0, bytes: 0, available: false }
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(size), 0) AS bytes FROM audio').get() as Record<string, unknown> | undefined
      return { entries: Number(row?.entries ?? 0), bytes: Number(row?.bytes ?? 0), available: true }
    } catch { return { entries: 0, bytes: 0, available: false } }
  }
  clear(): void {
    if (!this.db) return
    try { this.db.exec('DELETE FROM audio'); this.db.exec('VACUUM') } catch { /* 尽力而为 */ }
  }
  close(): void {
    try { this.db?.close() } catch { /* 尽力而为 */ }
    this.db = undefined
  }
}
