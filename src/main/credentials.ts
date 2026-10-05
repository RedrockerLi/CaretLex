import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { atomicSettingsWrite, CaretLexError, revision } from './repositories'

export class CredentialRepository {
  readonly path: string
  private queue: Promise<void> = Promise.resolve()
  constructor(userData: string) { this.path = resolve(userData, 'credentials.json') }
  private async read(): Promise<{ records: Record<string, string>; revision?: string }> {
    let bytes: Buffer
    try { bytes = await readFile(this.path) } catch (cause) {
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') return { records: {} }
      throw new CaretLexError('CREDENTIAL_UNAVAILABLE', '本机凭据文件无法读取。')
    }
    try {
      if (bytes.byteLength > 1024 * 1024) throw new Error()
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([ref, key]) => !/^key-[a-f0-9-]{36}$/.test(ref) || typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))) throw new Error()
      return { records: value, revision: revision(bytes) }
    } catch { throw new CaretLexError('CREDENTIAL_CORRUPT', '本机凭据文件损坏，原文件保留，请人工修复。') }
  }
  async save(key: string): Promise<string> {
    if (typeof key !== 'string' || !key.trim() || key.length > 16384 || /[\r\n]/.test(key)) throw new CaretLexError('INVALID_KEY', 'Key 必须是非空单行文本，长度不超过 16384。')
    const previous = this.queue; let release!: () => void
    this.queue = new Promise<void>(done => { release = done }); await previous
    try {
      const current = await this.read(); const ref = `key-${randomUUID()}`
      const bytes = Buffer.from(JSON.stringify({ ...current.records, [ref]: key }))
      if (bytes.byteLength > 1024 * 1024) throw new CaretLexError('CREDENTIAL_TOO_LARGE', '本机凭据文件超过 1 MiB。')
      await atomicSettingsWrite(this.path, bytes, current.revision)
      return ref
    } finally { release() }
  }
  async get(ref: string): Promise<string> {
    if (!/^key-[a-f0-9-]{36}$/.test(ref)) throw new CaretLexError('INVALID_KEY_REF', '凭据引用无效。')
    const key = (await this.read()).records[ref]
    if (!key) throw new CaretLexError('CREDENTIAL_MISSING', '此凭据引用在本机不存在，请重新保存 Key。')
    return key
  }
  async status(ref?: string): Promise<{ exists: boolean; error?: string }> {
    if (!ref) return { exists: false }
    try { await this.get(ref); return { exists: true } } catch (cause) { return { exists: false, error: cause instanceof Error ? cause.message : '本机凭据不可用。' } }
  }
}
