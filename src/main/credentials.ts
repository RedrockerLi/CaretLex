import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { atomicSettingsWrite, CaretLexError, revision } from './repositories'

/** 掩码：保留前 5 与后 4 个字符；短 Key 只留省略号。完整 Key 不离开主进程。 */
function maskKey(key: string): string {
  return key.length >= 12 ? `${key.slice(0, 5)}…${key.slice(-4)}` : '…'
}

export class CredentialRepository {
  readonly path: string
  private queue: Promise<void> = Promise.resolve()
  constructor(userData: string) { this.path = resolve(userData, 'credentials.json') }
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue; let release!: () => void
    this.queue = new Promise<void>(done => { release = done }); await previous
    try { return await operation() } finally { release() }
  }
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
    return this.serial(async () => {
      const current = await this.read(); const ref = `key-${randomUUID()}`
      const bytes = Buffer.from(JSON.stringify({ ...current.records, [ref]: key }))
      if (bytes.byteLength > 1024 * 1024) throw new CaretLexError('CREDENTIAL_TOO_LARGE', '本机凭据文件超过 1 MiB。')
      await atomicSettingsWrite(this.path, bytes, current.revision)
      return ref
    })
  }
  async remove(ref: string): Promise<void> {
    if (!/^key-[a-f0-9-]{36}$/.test(ref)) throw new CaretLexError('INVALID_KEY_REF', '凭据引用无效。')
    return this.serial(async () => {
      const current = await this.read()
      if (!Object.hasOwn(current.records, ref)) return
      const records = { ...current.records }; delete records[ref]
      const bytes = Buffer.from(JSON.stringify(records))
      if (bytes.byteLength > 1024 * 1024) throw new CaretLexError('CREDENTIAL_TOO_LARGE', '本机凭据文件超过 1 MiB。')
      await atomicSettingsWrite(this.path, bytes, current.revision)
    })
  }
  async get(ref: string): Promise<string> {
    if (!/^key-[a-f0-9-]{36}$/.test(ref)) throw new CaretLexError('INVALID_KEY_REF', '凭据引用无效。')
    const key = (await this.read()).records[ref]
    if (!key) throw new CaretLexError('CREDENTIAL_MISSING', '此凭据引用在本机不存在，请重新保存 Key。')
    return key
  }
  async status(ref?: string): Promise<{ exists: boolean; masked?: string; error?: string }> {
    if (!ref) return { exists: false }
    try { return { exists: true, masked: maskKey(await this.get(ref)) } } catch (cause) { return { exists: false, error: cause instanceof Error ? cause.message : '本机凭据不可用。' } }
  }
}
