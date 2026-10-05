import { createHash, randomUUID } from 'node:crypto'
import { watch as watchFile, type FSWatcher } from 'node:fs'
import { constants, chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { DocumentSnapshot } from '../shared/types'
import { parseDocument } from '../shared/protocol'
import { defaultSettings, parseSettings, type AppSettings } from '../shared/settings'
import type { SettingsSnapshot } from '../shared/bridge'
import { serializeJsonValue } from '../shared/json'

const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024
const MAX_SETTINGS_BYTES = 1024 * 1024

export class CaretLexError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'CaretLexError'
  }
}

export interface OpenDocument {
  error?: string
  snapshot: DocumentSnapshot
  parsed: ReturnType<typeof parseDocument>
}

export class DocumentRepository {
  private readonly sessions = new Map<string, Session>()
  private readonly pathIds = new Map<string, string>()
  private readonly opening = new Map<string, Promise<OpenDocument>>()
  private readonly queues = new Map<string, Promise<void>>()
  private changed?: (documentId: string, document: OpenDocument) => void

  setChangeListener(listener: (documentId: string, document: OpenDocument) => void): void {
    this.changed = listener
  }

  async create(): Promise<OpenDocument> {
    const session: Session = {
      id: randomUUID(), text: '', bom: false, eol: '\n', path: undefined, revision: undefined
    }
    this.sessions.set(session.id, session)
    return this.toResult(session)
  }

  async open(path: string): Promise<OpenDocument> {
    const canonical = await realpath(path)
    const inFlight = this.opening.get(canonical)
    if (inFlight) return inFlight
    const pending = this.runSerial(`path:${canonical}`, async () => {
      const existingId = this.pathIds.get(canonical)
      if (existingId) return this.toResult(this.getSession(existingId))
      const bytes = await readFile(canonical)
      const data = decodeDocument(bytes)
      const session: Session = {
        id: randomUUID(), path: canonical, text: data.text, bytes, revision: revision(bytes),
        bom: data.bom, eol: detectEol(data.text)
      }
      this.sessions.set(session.id, session)
      this.pathIds.set(canonical, session.id)
      this.startWatch(session)
      return this.toResult(session)
    })
    this.opening.set(canonical, pending)
    try { return await pending } finally { if (this.opening.get(canonical) === pending) this.opening.delete(canonical) }
  }

  async get(id: string): Promise<OpenDocument> {
    return this.runSerial(`document:${id}`, () => this.toResult(this.getSession(id)))
  }

  async verifyRevision(id: string, expected?: string): Promise<OpenDocument> {
    return this.runSerial(`document:${id}`, async () => {
      const session = this.getSession(id)
      if (session.path) await this.assertCurrent(session, expected)
      else if (expected !== undefined) throw new CaretLexError('CONFLICT', '未命名文档没有磁盘版本。')
      return this.toResult(session)
    })
  }

  async saveSource(id: string, text: string, baseRevision?: string): Promise<OpenDocument> {
    assertText(text)
    return this.runSerial(`document:${id}`, async () => {
      const session = this.getSession(id)
      if (!session.path) throw new CaretLexError('PATH_REQUIRED', '新文档需要先选择保存位置。')
      if (!baseRevision) throw new CaretLexError('REVISION_REQUIRED', '保存已命名文档必须提供编辑时的文件版本。')
      return this.runSerial(`path:${session.path}`, async () => {
        await this.assertCurrent(session, baseRevision)
        await this.writeSession(session, text, baseRevision)
        return this.toResult(session)
      })
    })
  }

  async saveAs(id: string, path: string, text: string, baseRevision?: string): Promise<OpenDocument> {
    assertText(text)
    return this.runSerial(`document:${id}`, async () => {
      const session = this.getSession(id)
      if (session.path && !baseRevision) throw new CaretLexError('REVISION_REQUIRED', '另存已命名文档必须提供编辑时的文件版本。')
      const canonicalTarget = await canonicalSavePath(path)
      if (session.path) await this.assertCurrent(session, baseRevision)
      return this.runSerial(`path:${canonicalTarget}`, async () => {
        if (session.path === canonicalTarget) {
          await this.writeSession(session, text, baseRevision)
          return this.toResult(session)
        }
        const openedId = this.pathIds.get(canonicalTarget)
        if (openedId && openedId !== id) throw new CaretLexError('PATH_ALREADY_OPEN', '该文件已在另一个标签页打开，请切换到已有标签页。')
        let targetRevision: string | undefined
        let targetStat: Awaited<ReturnType<typeof stat>> | undefined
        try {
          const bytes = await readFile(canonicalTarget)
          targetRevision = revision(bytes)
          targetStat = await stat(canonicalTarget)
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
        const oldPath = session.path
        const targetMode = targetStat === undefined ? undefined : Number(targetStat.mode)
        await this.writePath(canonicalTarget, text, session.bom, targetRevision, targetMode)
        if (oldPath) {
          this.stopWatch(session)
          if (this.pathIds.get(oldPath) === session.id) this.pathIds.delete(oldPath)
        }
        session.path = canonicalTarget
        session.text = text
        session.eol = detectEol(text)
        session.bytes = encodeDocument(text, session.bom)
        session.revision = revision(session.bytes)
        this.pathIds.set(canonicalTarget, session.id)
        this.startWatch(session)
        return this.toResult(session)
      })
    })
  }

  async close(id: string): Promise<void> {
    await this.runSerial(`document:${id}`, async () => {
      const session = this.sessions.get(id)
      if (!session) return
      this.stopWatch(session)
      this.sessions.delete(id)
      if (session.path && this.pathIds.get(session.path) === id) this.pathIds.delete(session.path)
    })
  }

  async resolveLocalImage(id: string, source: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const session = this.getSession(id)
    if (!session.path || !source || source.startsWith('//')) return null
    let decoded: string
    try { decoded = decodeURIComponent(source) } catch { return null }
    if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.includes('\0') || decoded.includes('\\')) return null
    const root = await realpath(dirname(session.path))
    const lexical = resolve(root, decoded)
    if (!isWithin(root, lexical)) return null
    let actual: string
    try { actual = await realpath(lexical) } catch { return null }
    if (!isWithin(root, actual)) return null
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW)
      const descriptorPath = await realpath(`/proc/self/fd/${handle.fd}`)
      if (!isWithin(root, descriptorPath)) return null
      const info = await handle.stat()
      if (!info.isFile() || info.size > 10 * 1024 * 1024) return null
      const chunks: Buffer[] = []
      let total = 0
      while (total <= 10 * 1024 * 1024) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, 10 * 1024 * 1024 + 1 - total))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (!bytesRead) break
        total += bytesRead
        if (total > 10 * 1024 * 1024) return null
        chunks.push(chunk.subarray(0, bytesRead))
      }
      return { bytes: Buffer.concat(chunks, total), mime: mimeForPath(descriptorPath) }
    } catch {
      return null
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  getOpenPaths(): string[] {
    return [...this.pathIds.keys()]
  }

  private getSession(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) throw new CaretLexError('UNKNOWN_DOCUMENT', '文档会话已经关闭，请重新打开文件。')
    return session
  }

  private async runSerial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveQueue) => { release = resolveQueue })
    this.queues.set(key, current)
    await previous
    try { return await operation() }
    finally {
      release()
      if (this.queues.get(key) === current) this.queues.delete(key)
    }
  }

  private async toResult(session: Session): Promise<OpenDocument> {
    const snapshot: DocumentSnapshot = {
      id: session.id,
      ...(session.path ? { path: session.path } : {}),
      text: session.text,
      ...(session.revision ? { revision: session.revision } : {}),
      bom: session.bom,
      eol: session.eol
    }
    return { snapshot, parsed: parseDocument(session.text) }
  }

  private async assertCurrent(session: Session, expected?: string): Promise<void> {
    if (!session.path) throw new CaretLexError('PATH_REQUIRED', '文档尚未保存。')
    let bytes: Buffer
    try { bytes = await readFile(session.path) } catch {
      throw new CaretLexError('CONFLICT', '磁盘上的文件已不存在。请另存为或重新打开文档。')
    }
    const actual = revision(bytes)
    if (!expected || actual !== expected) {
      const data = decodeDocument(bytes)
      session.text = data.text
      session.bytes = bytes
      session.revision = actual
      session.bom = data.bom
      session.eol = detectEol(data.text)
      this.changed?.(session.id, await this.toResult(session))
      throw new CaretLexError('CONFLICT', '磁盘文件已在外部修改。当前草稿已保留，请重新加载或另存为。')
    }
  }

  private async writeSession(session: Session, text: string, expected?: string): Promise<void> {
    const path = session.path
    if (!path) throw new CaretLexError('PATH_REQUIRED', '文档尚未保存。')
    const currentStat = await stat(path)
    await this.writePath(path, text, session.bom, expected, currentStat.mode)
    const bytes = encodeDocument(text, session.bom)
    session.text = text
    session.bytes = bytes
    session.revision = revision(bytes)
    session.eol = detectEol(text)
    this.changed?.(session.id, await this.toResult(session))
  }

  private async writePath(path: string, text: string, bom: boolean, expected?: string, mode?: number): Promise<void> {
    const bytes = encodeDocument(text, bom)
    if (bytes.byteLength > MAX_MARKDOWN_BYTES) throw new CaretLexError('TOO_LARGE', 'Markdown 文件超过 16 MiB 限制。')
    const dir = dirname(path)
    const temp = resolve(dir, `.caretlex-${process.pid}-${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode !== undefined ? mode & 0o777 : 0o600)
      await handle.writeFile(bytes)
      if (mode !== undefined) await chmod(temp, mode & 0o777)
      await handle.sync()
      await handle.close()
      handle = undefined
      if (expected !== undefined) {
        const current = await readFile(path)
        if (revision(current) !== expected) throw new CaretLexError('CONFLICT', '写入前检测到文件再次变化，未覆盖外部修改。')
      } else {
        try {
          await lstat(path)
          throw new CaretLexError('CONFLICT', '目标文件已存在；请重新选择保存位置。')
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
      }
      await rename(temp, path)
      // rename is the commit point. Directory fsync improves crash durability where
      // supported, but its failure must not make a completed write look rejected.
      try {
        const dirHandle = await open(dir, constants.O_RDONLY)
        try { await dirHandle.sync() } finally { await dirHandle.close() }
      } catch { /* The file was already committed by rename. */ }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private startWatch(session: Session): void {
    if (!session.path || session.watcher) return
    try {
      session.watcher = watchFile(dirname(session.path), { persistent: false }, (_event, name) => {
        if (name && name.toString() !== basename(session.path!)) return
        void this.refreshExternal(session.id)
      })
      session.watcher.on('error', () => this.stopWatch(session))
    } catch {
      session.watcher = undefined
    }
  }

  private stopWatch(session: Session): void {
    session.watcher?.close()
    session.watcher = undefined
  }

  private async refreshExternal(id: string): Promise<void> {
    await this.runSerial(`document:${id}`, async () => {
      const session = this.sessions.get(id)
      if (!session?.path) return
      try {
        const bytes = await readFile(session.path)
        const nextRevision = revision(bytes)
        if (nextRevision === session.revision) return
        const data = decodeDocument(bytes)
        session.bytes = bytes
        session.text = data.text
        session.revision = nextRevision
        session.bom = data.bom
        session.eol = detectEol(data.text)
    try { this.changed?.(session.id, await this.toResult(session)) } catch { /* The write is already committed. */ }
      } catch (cause) {
        this.changed?.(session.id, { ...await this.toResult(session), error: cause instanceof Error ? cause.message : '外部文档无法安全读取。' })
      }
    })
  }
}

interface Session {
  id: string
  path?: string
  text: string
  bytes?: Buffer
  revision?: string
  bom: boolean
  eol: '\n' | '\r\n' | '\r'
  watcher?: FSWatcher
}

export class SettingsRepository {
  private settingsPath?: string
  private snapshot?: SettingsSnapshot
  private watcher?: FSWatcher
  private changed?: () => void
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly userDataPath: string) {}
  setChangeListener(listener: () => void): void { this.changed = listener }
  async load(): Promise<SettingsSnapshot> {
    return this.runExclusive(async () => {
      const before = this.snapshot; const next = await this.loadUnlocked()
      if (before && (before.revision !== next.revision || before.error !== next.error)) this.changed?.()
      return next
    })
  }
  private async loadUnlocked(): Promise<SettingsSnapshot> {
    let path = this.settingsPath ?? resolve(this.userDataPath, 'settings.json')
    let observedRevision: string | undefined
    let observedMissing = false
    try {
      path = await this.resolvePath()
      let bytes: Buffer
      try { bytes = await readFile(path) } catch (error) {
        observedMissing = isNotFound(error)
        if (!isNotFound(error) || this.snapshot || path !== resolve(this.userDataPath, 'settings.json')) throw new CaretLexError('SETTINGS_MISSING', `设置文件无法读取：${path}`)
        bytes = Buffer.from(`${JSON.stringify(defaultSettings, null, 2)}\n`)
        await atomicSettingsWrite(path, bytes)
      }
      observedRevision = revision(bytes)
      this.snapshot = { path, revision: revision(bytes) }
      if (bytes.byteLength > MAX_SETTINGS_BYTES) throw new CaretLexError('SETTINGS_INVALID', '设置文件超过 1 MiB 限制。')
      const text = decodeUtf8(bytes)
      this.snapshot.text = text
      const parsed = parseSettings(text)
      if (!parsed.ok) this.snapshot.error = parsed.error.message
      else this.snapshot.value = parsed.value
    } catch (cause) {
      this.snapshot = { path, revision: this.snapshot?.path === path ? this.snapshot.revision : '', error: cause instanceof Error ? cause.message : '设置文件无法读取。' }
    }
    try {
      const state = await this.resetState()
      // Bind recovery to bytes actually shown to the user, even if a file changes during load.
      this.snapshot!.resetToken = (observedRevision !== undefined || observedMissing) && state.path === path
        ? this.recoveryToken(path, state.pointerRevision, observedRevision) : state.token
    } catch { /* Unreadable paths cannot be overwritten safely. */ }
    this.startWatch()
    return this.snapshot!
  }
  async save(value: unknown, baseRevision?: string): Promise<SettingsSnapshot> {
    return this.runExclusive(async () => {
      if (!baseRevision) throw new CaretLexError('REVISION_REQUIRED', '保存设置必须提供加载时的文件版本。')
      const path = await this.resolvePath()
      const json = serializeJsonValue(value)
      if (!json || Buffer.byteLength(json) > MAX_SETTINGS_BYTES) throw new CaretLexError('SETTINGS_INVALID', '设置必须是有限且不超过 1 MiB 的 JSON。')
      const parsed = parseSettings(json)
      if (!parsed.ok) throw new CaretLexError('SETTINGS_INVALID', parsed.error.message)
      const currentBytes = await readFile(path)
      if (currentBytes.byteLength > MAX_SETTINGS_BYTES) throw new CaretLexError('SETTINGS_INVALID', '原设置文件超过 1 MiB，请重新选择文件。')
      decodeUtf8(currentBytes) // Never replace bytes that cannot be safely decoded.
      if (revision(currentBytes) !== baseRevision) throw new CaretLexError('CONFLICT', '设置文件已在外部修改，草稿保留，未覆盖。')
      const text = `${JSON.stringify(parsed.value, null, 2)}\n`
      const bytes = Buffer.from(text)
      if (bytes.byteLength > MAX_SETTINGS_BYTES) throw new CaretLexError('SETTINGS_INVALID', '格式化后的设置超过 1 MiB。')
      await atomicSettingsWrite(path, bytes, baseRevision)
      this.snapshot = { value: parsed.value, text, revision: revision(bytes), path }
      try {
        const state = await this.resetState()
        this.snapshot.resetToken = this.recoveryToken(path, state.pointerRevision, revision(bytes))
      } catch { /* The settings write is already committed. */ }
      this.changed?.()
      return this.snapshot
    })
  }
  private recoveryToken(path: string, pointerRevision?: string, fileRevision?: string): string {
    return revision(Buffer.from(JSON.stringify({ path, pointerRevision, fileRevision })))
  }
  private async resetState() {
    const pointer = resolve(this.userDataPath, 'settings-path.json')
    const pointerRevision = await tryRevision(pointer)
    let path: string
    let brokenPointer = false
    try { path = await this.resolvePath() } catch (cause) {
      if (!(cause instanceof CaretLexError) || cause.code !== 'SETTINGS_POINTER_INVALID') throw cause
      path = resolve(this.userDataPath, 'settings.json'); brokenPointer = true
    }
    await this.assertAllowedPath(path)
    const fileRevision = await tryRevision(path)
    const token = this.recoveryToken(path, pointerRevision, fileRevision)
    return { token, path, fileRevision, pointer, pointerRevision, brokenPointer }
  }
  async resetDefaults(token: string): Promise<SettingsSnapshot> {
    return this.runExclusive(async () => {
      const state = await this.resetState()
      if (token !== state.token) throw new CaretLexError('CONFLICT', '设置文件或位置已变化，请重新加载后恢复默认设置。')
      await atomicSettingsWrite(state.path, Buffer.from(`${JSON.stringify(defaultSettings, null, 2)}\n`), state.fileRevision)
      if (state.brokenPointer) {
        await atomicSettingsWrite(state.pointer, Buffer.from(`${JSON.stringify({ path: state.path }, null, 2)}\n`), state.pointerRevision)
        this.settingsPath = state.path
      }
      const next = await this.loadUnlocked()
      this.changed?.()
      return next
    })
  }
  private async assertAllowedPath(destination: string): Promise<void> {
    for (const name of ['settings-path.json', 'credentials.json']) {
      const local = resolve(this.userDataPath, name)
      if (destination === local || destination === await canonicalSavePath(local)) throw new CaretLexError('SETTINGS_PATH_RESERVED', '本机凭据文件和设置路径指针不能用作设置 JSON 文件。')
    }
  }
  async migrateTo(targetPath: string): Promise<SettingsSnapshot> {
    return this.runExclusive(async () => {
      const current = await this.loadUnlocked()
      if (!current.value) throw new CaretLexError('SETTINGS_INVALID', '请恢复默认设置，或选择可用的设置文件。')
      const destination = await canonicalSavePath(targetPath)
      await this.assertAllowedPath(destination)
      if (destination === current.path) return current
      const bytes = Buffer.from(current.text!)
      await atomicSettingsWrite(destination, bytes, await tryRevision(destination))
      if (await tryRevision(current.path) !== current.revision) throw new CaretLexError('CONFLICT', '迁移期间原设置文件已变化；新副本已保留，尚未切换路径。')
      await this.switchPath(destination)
      return this.loadUnlocked()
    })
  }
  async selectExistingPath(targetPath: string): Promise<SettingsSnapshot> {
    return this.runExclusive(async () => {
      const destination = await realpath(targetPath)
      await this.assertAllowedPath(destination)
      const bytes = await readFile(destination)
      if (bytes.byteLength > MAX_SETTINGS_BYTES) throw new CaretLexError('SETTINGS_INVALID', '设置文件超过 1 MiB。')
      const parsed = parseSettings(decodeUtf8(bytes))
      if (!parsed.ok) throw new CaretLexError('SETTINGS_INVALID', parsed.error.message)
      await this.switchPath(destination)
      return this.loadUnlocked()
    })
  }
  private async switchPath(destination: string): Promise<void> {
    const pointer = resolve(this.userDataPath, 'settings-path.json')
    await atomicSettingsWrite(pointer, Buffer.from(`${JSON.stringify({ path: destination }, null, 2)}\n`), await tryRevision(pointer))
    const prior = this.settingsPath
    this.stopWatch(); this.settingsPath = destination
    if (prior === resolve(this.userDataPath, 'settings.json') && prior !== destination) await rm(prior, { force: true }).catch(() => undefined)
    this.startWatch(); this.changed?.()
  }
  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>(done => { release = done })
    await previous
    try { return await operation() } finally { release() }
  }
  status(): SettingsSnapshot { return this.snapshot ?? { path: this.settingsPath ?? resolve(this.userDataPath, 'settings.json'), revision: '', error: '设置尚未读取。' } }
  private async resolvePath(): Promise<string> {
    if (this.settingsPath) return this.settingsPath
    const pointer = resolve(this.userDataPath, 'settings-path.json')
    try {
      const bytes = await readFile(pointer)
      if (bytes.byteLength > MAX_SETTINGS_BYTES) throw new Error('路径指针过大')
      const parsed = JSON.parse(decodeUtf8(bytes)) as { path?: unknown }
      if (typeof parsed.path !== 'string' || !isAbsolute(parsed.path)) throw new Error('路径指针格式无效')
      const path = resolve(parsed.path)
      await this.assertAllowedPath(path)
      this.settingsPath = path
    } catch (cause) {
      if (!isNotFound(cause)) throw new CaretLexError('SETTINGS_POINTER_INVALID', '本机设置路径指针损坏；请重新选择文件。')
      this.settingsPath = resolve(this.userDataPath, 'settings.json')
    }
    return this.settingsPath
  }
  private startWatch(): void {
    if (!this.settingsPath || this.watcher) return
    try {
      this.watcher = watchFile(dirname(this.settingsPath), { persistent: false }, (_event, name) => {
        if (name && name.toString() !== basename(this.settingsPath!)) return
        void this.runExclusive(async () => {
          const before = this.snapshot
          const next = await this.loadUnlocked()
          if (next.revision !== before?.revision || next.error !== before?.error) this.changed?.()
        })
      })
      this.watcher.on('error', () => this.stopWatch())
    } catch { this.watcher = undefined }
  }
  private stopWatch(): void { this.watcher?.close(); this.watcher = undefined }
}

export function revision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function decodeDocument(bytes: Buffer): { text: string; bom: boolean } {
  if (bytes.byteLength > MAX_MARKDOWN_BYTES) throw new CaretLexError('TOO_LARGE', 'Markdown 文件超过 16 MiB 限制。')
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  return { text: decodeUtf8(bom ? bytes.subarray(3) : bytes), bom }
}

function decodeUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new CaretLexError('ENCODING', '文件不是有效 UTF-8，已拒绝读取或写入。') }
}

export function encodeDocument(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf8')
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body
}

function detectEol(text: string): '\n' | '\r\n' | '\r' {
  const first = text.match(/\r\n|\n|\r/)
  return (first?.[0] ?? '\n') as '\n' | '\r\n' | '\r'
}

function assertText(text: unknown): asserts text is string {
  if (typeof text !== 'string') throw new CaretLexError('INVALID_ARGUMENT', '文档内容必须是文本。')
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CaretLexError('INVALID_TEXT', '文档草稿含有未配对的 Unicode 代理字符，未保存。')
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CaretLexError('INVALID_TEXT', '文档草稿含有未配对的 Unicode 代理字符，未保存。')
    }
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_MARKDOWN_BYTES) throw new CaretLexError('TOO_LARGE', 'Markdown 文件超过 16 MiB 限制。')
}

export async function atomicSettingsWrite(path: string, bytes: Buffer, expected?: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = resolve(dirname(path), `.caretlex-settings-${process.pid}-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    if (expected === undefined) {
      if (await tryRevision(path)) throw new CaretLexError('CONFLICT', '设置目标文件已存在，未覆盖。')
    } else {
      const current = await readFile(path)
      if (revision(current) !== expected) throw new CaretLexError('CONFLICT', '设置文件已变化，未覆盖。')
    }
    await rename(temp, path)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function tryRevision(path: string): Promise<string | undefined> {
  try { return revision(await readFile(path)) }
  catch (error) { if (isNotFound(error)) return undefined; throw error }
}

function isNotFound(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }

export async function canonicalSavePath(path: string): Promise<string> {
  const absolute = resolve(path)
  try { return await realpath(absolute) }
  catch (error) {
    if (!isNotFound(error)) throw error
    return resolve(await realpath(dirname(absolute)), basename(absolute))
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function mimeForPath(path: string): string {
  const ext = extname(path).toLowerCase()
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif' } as Record<string, string>)[ext] ?? 'application/octet-stream'
}
