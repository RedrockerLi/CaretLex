import { app, BrowserWindow, dialog, ipcMain, Menu, net, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, rename, rm, open, constants } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { DocumentRepository, SettingsRepository, CaretLexError, canonicalSavePath, revision, type OpenDocument } from './repositories'
import { planAdd, planDelete, planEdit, exportVocabulary } from '../shared/patch'
import { ProviderService } from './providers'
import { CredentialRepository } from './credentials'
import { createLlmAdapter } from './llm'
import { createDictionaryClient } from './dictionary'
import { DictionaryCache } from './dictionary-cache'
import { documentToWire } from '../shared/document-wire'
import { validateIdentity } from '../shared/entries'
import { serializeJsonValue } from '../shared/json'
import type { DocumentResult, SaveResult } from '../shared/bridge'
import type { SourceSpan } from '../shared/types'
import { applicationMenuTemplate, updateApplicationMenu } from './menu'
import { initialMenuState, isMenuState } from '../shared/menu'
import { ensureLinuxDesktopEntry, xdgDataHome } from './desktop-integration'

const documents = new DocumentRepository()
let settings: SettingsRepository
let providers: ProviderService
let credentials: CredentialRepository
let dictionaryCache: DictionaryCache
let mainWindow: BrowserWindow | undefined
let closeAllowed = false
let currentMenuState = initialMenuState
let initialFile: string | undefined = process.argv.slice(1).find((arg) => /\.md(?:own)?$/i.test(arg) && !arg.startsWith('-'))
const MAX_INPUT_TEXT_BYTES = 16 * 1024 * 1024
const moduleDirectory = __dirname
// 开发（out/main）、打包（app.asar/out/main）与菜单 smoke 三种布局下指向同一相对位置。
const windowIconPath = () => resolve(moduleDirectory, '../../branding/app-icon.png')

function asDocumentResult(value: OpenDocument): DocumentResult {
  return documentToWire(value)
}

function sendDocument(documentId: string, value: OpenDocument): void {
  providers?.cancelAll(documentId)
  mainWindow?.webContents.send('document:changed', { documentId, document: asDocumentResult(value) })
}

function isTrusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false
  const url = event.senderFrame.url
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    try {
      const actual = new URL(url)
      const expected = new URL(devUrl)
      return actual.origin === expected.origin && actual.pathname === expected.pathname
    } catch { return false }
  }
  return url === pathToFileURL(resolve(moduleDirectory, '../renderer/index.html')).href
}

function guard(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!isTrusted(event)) throw new CaretLexError('UNTRUSTED_SENDER', '此操作只能由 CaretLex 主窗口发起。')
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CaretLexError('INVALID_ARGUMENT', 'IPC 参数格式无效。')
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) throw new CaretLexError('INVALID_ARGUMENT', `${label} 参数无效。`)
  return value
}

function requireSpan(value: unknown): SourceSpan {
  const raw = requireRecord(value)
  if (!Number.isSafeInteger(raw.start) || !Number.isSafeInteger(raw.end) || (raw.start as number) < 0 || (raw.end as number) <= (raw.start as number)) {
    throw new CaretLexError('INVALID_ARGUMENT', '选词范围无效。')
  }
  return { start: raw.start as number, end: raw.end as number }
}

function assertJsonSize(value: unknown): void {
  const serialized = serializeJsonValue(value)
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) {
    throw new CaretLexError('INVALID_ARGUMENT', '词条必须是有限且可序列化的 JSON 值，大小不能超过 1 MiB。')
  }
}

async function chooseMarkdownSavePath(defaultName = '未命名.md'): Promise<string | null> {
  if (!mainWindow) return null
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存 Markdown 文档',
    defaultPath: defaultName,
    filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown'] }]
  })
  return result.canceled ? null : result.filePath
}

async function saveAsDialog(documentId: string, text: string, baseRevision?: string): Promise<OpenDocument | null> {
  const current = await documents.get(documentId)
  const target = await chooseMarkdownSavePath(current.snapshot.path ? undefined : '未命名.md')
  if (!target) return null
  return documents.saveAs(documentId, target, text, baseRevision)
}

function resultWithChange(value: OpenDocument, changed: boolean): SaveResult {
  return { ...asDocumentResult(value), changed }
}

async function currentForMutation(documentId: string, baseRevision?: string): Promise<OpenDocument> {
  let current = await documents.get(documentId)
  let expectedRevision = baseRevision
  if (!current.snapshot.path) {
    const saved = await saveAsDialog(documentId, current.snapshot.text, baseRevision)
    if (!saved) throw new CaretLexError('SAVE_CANCELLED', '请先为新文档选择保存位置。')
    current = saved
    expectedRevision = saved.snapshot.revision
  }
  if (!expectedRevision) throw new CaretLexError('REVISION_REQUIRED', '词条操作必须提供选择时的文件版本。')
  return documents.verifyRevision(documentId, expectedRevision)
}

function requireBaseRevision(value: unknown): string | undefined {
  return value === undefined ? undefined : requireString(value, 'baseRevision', 128)
}

function registerHandlers(): void {
  ipcMain.handle('edit:history', (event, command: unknown) => {
    guard(event)
    if (command === 'undo') mainWindow?.webContents.undo()
    else if (command === 'redo') mainWindow?.webContents.redo()
    else throw new CaretLexError('INVALID_ARGUMENT', '编辑历史命令无效。')
  })
  ipcMain.on('menu:state', (event, state: unknown) => {
    guard(event)
    const menu = Menu.getApplicationMenu()
    if (menu && isMenuState(state)) {
      currentMenuState = state
      updateApplicationMenu(menu, state)
    }
  })
  ipcMain.handle('document:startup', async (event) => {
    guard(event)
    if (!initialFile) return null
    const path = initialFile
    initialFile = undefined
    return asDocumentResult(await documents.open(path))
  })

  ipcMain.handle('document:open', async (event) => {
    guard(event)
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开 Markdown 文档',
      properties: ['openFile'],
      filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown', 'mdown'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return asDocumentResult(await documents.open(result.filePaths[0]))
  })

  ipcMain.handle('document:new', async (event) => {
    guard(event)
    return asDocumentResult(await documents.create())
  })

  ipcMain.handle('document:close', async (event, rawId: unknown) => {
    guard(event)
    const id = requireString(rawId, 'documentId', 64)
    providers.cancelAll(id)
    await documents.close(id)
  })

  ipcMain.handle('document:save-source', async (event, raw: unknown) => {
    guard(event)
    const input = requireRecord(raw)
    const id = requireString(input.documentId, 'documentId', 64)
    const text = requireString(input.text, 'text', MAX_INPUT_TEXT_BYTES)
    const baseRevision = requireBaseRevision(input.baseRevision)
    let current = await documents.get(id)
    if (!current.snapshot.path) {
      const saved = await saveAsDialog(id, text, baseRevision)
      return saved ? resultWithChange(saved, true) : null
    }
    if (!baseRevision) throw new CaretLexError('REVISION_REQUIRED', '保存已命名文档必须提供编辑时的文件版本。')
    current = await documents.verifyRevision(id, baseRevision)
    const saved = await documents.saveSource(id, text, current.snapshot.revision)
    return resultWithChange(saved, true)
  })

  ipcMain.handle('document:save-as', async (event, raw: unknown) => {
    guard(event)
    const input = requireRecord(raw)
    const id = requireString(input.documentId, 'documentId', 64)
    const text = requireString(input.text, 'text', MAX_INPUT_TEXT_BYTES)
    return (await saveAsDialog(id, text, requireBaseRevision(input.baseRevision)))
      ? resultWithChange(await documents.get(id), true)
      : null
  })

  ipcMain.handle('vocab:add', async (event, raw: unknown) => {
    guard(event)
    const input = requireRecord(raw)
    const id = requireString(input.documentId, 'documentId', 64)
    const baseRevision = requireBaseRevision(input.baseRevision)
    const span = requireSpan(input.sourceSpan)
    const selected = requireString(input.selected, 'selected', 128)
    const lemma = requireString(input.lemma, 'lemma', 128)
    assertJsonSize(input.value)
    const current = await documents.verifyRevision(id, baseRevision)
    const identity = validateIdentity(input.value as never, lemma, current.parsed.entries.get(lemma)?.value)
    if (!identity.ok) throw new CaretLexError(identity.error.code, identity.error.message)
    const planned = planAdd(current.snapshot.text, { span, selected, lemma, value: input.value as never })
    if (!planned.ok) throw new CaretLexError(planned.error.code, planned.error.message)
    if (!planned.value.changed) return resultWithChange(current, false)
    const saved = current.snapshot.path ? await documents.saveSource(id, planned.value.text, current.snapshot.revision) : await saveAsDialog(id, planned.value.text, baseRevision)
    if (!saved) throw new CaretLexError('SAVE_CANCELLED', '保存位置选择已取消，草稿保留。')
    return resultWithChange(saved, true)
  })

  ipcMain.handle('vocab:edit', async (event, raw: unknown) => {
    guard(event)
    const input = requireRecord(raw)
    const id = requireString(input.documentId, 'documentId', 64)
    const lemma = requireString(input.lemma, 'lemma', 128)
    assertJsonSize(input.value)
    const current = await currentForMutation(id, requireBaseRevision(input.baseRevision))
    const identity = validateIdentity(input.value as never, lemma, current.parsed.entries.get(lemma)?.value)
    if (!identity.ok) throw new CaretLexError(identity.error.code, identity.error.message)
    const planned = planEdit(current.snapshot.text, { lemma, value: input.value as never })
    if (!planned.ok) throw new CaretLexError(planned.error.code, planned.error.message)
    if (!planned.value.changed) return resultWithChange(current, false)
    const saved = await documents.saveSource(id, planned.value.text, current.snapshot.revision)
    return resultWithChange(saved, true)
  })

  ipcMain.handle('vocab:delete', async (event, raw: unknown) => {
    guard(event)
    const input = requireRecord(raw)
    const id = requireString(input.documentId, 'documentId', 64)
    const lemma = requireString(input.lemma, 'lemma', 128)
    const current = await currentForMutation(id, requireBaseRevision(input.baseRevision))
    const planned = planDelete(current.snapshot.text, { lemma })
    if (!planned.ok) throw new CaretLexError(planned.error.code, planned.error.message)
    if (!planned.value.changed) return resultWithChange(current, false)
    const saved = await documents.saveSource(id, planned.value.text, current.snapshot.revision)
    return resultWithChange(saved, true)
  })

  ipcMain.handle('vocab:export', async (event, rawId: unknown) => {
    guard(event)
    const id = requireString(rawId, 'documentId', 64)
    const current = await documents.verifyRevision(id, (await documents.get(id)).snapshot.revision)
    const exported = exportVocabulary(current.snapshot.text)
    if (!exported.ok) throw new CaretLexError(exported.error.code, exported.error.message)
    if (!mainWindow) throw new CaretLexError('NO_WINDOW', '应用窗口已关闭。')
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出当前文档词条',
      defaultPath: 'caretlex-vocabulary.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { kind: 'cancelled' as const }
    const target = resolve(result.filePath)
    const targetIdentity = await canonicalSavePath(target)
    if (documents.getOpenPaths().some((path) => resolve(path) === targetIdentity)) throw new CaretLexError('EXPORT_OVERWRITE', '不能将导出文件覆盖当前打开的 Markdown 文档。')
    await atomicOutput(target, Buffer.from(exported.value, 'utf8'))
    return { kind: 'saved' as const, path: target }
  })

  ipcMain.handle('settings:load', async (event) => {
    guard(event)
    return settings.load()
  })

  ipcMain.handle('settings:save', async (event, raw: unknown) => {
    guard(event)
    const input = requireRecord(raw)
    return settings.save(input.value, requireBaseRevision(input.baseRevision))
  })

  ipcMain.handle('settings:reset', (event, token: unknown) => {
    guard(event)
    return settings.resetDefaults(requireString(token, 'resetToken', 128))
  })

  ipcMain.handle('settings:migrate', async (event) => {
    guard(event)
    if (!mainWindow) return null
    let current: Awaited<ReturnType<SettingsRepository['load']>> | undefined
    try { current = await settings.load(); if (!current.value) throw new Error('invalid settings') } catch {
      const recovery = await dialog.showOpenDialog(mainWindow, {
        title: '选择可用的 CaretLex 设置 JSON',
        properties: ['openFile'],
        filters: [{ name: 'JSON 设置', extensions: ['json'] }]
      })
      if (recovery.canceled || !recovery.filePaths[0]) return null
      return settings.selectExistingPath(recovery.filePaths[0])
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '选择同步设置文件位置',
      defaultPath: current.path,
      filters: [{ name: 'JSON 设置', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    return settings.migrateTo(result.filePath)
  })

  const entryLocation = (raw: unknown) => {
    const input = requireRecord(raw)
    return { documentId: requireString(input.documentId, 'documentId', 64), baseRevision: requireBaseRevision(input.baseRevision), sourceSpan: requireSpan(input.sourceSpan), selected: requireString(input.selected, 'selected', 128) }
  }
  ipcMain.handle('provider:types', event => { guard(event); return providers.descriptions() })
  ipcMain.handle('provider:preset', (event, raw: unknown) => {
    guard(event); const input = requireRecord(raw); assertJsonSize(input.config)
    return providers.preset(requireString(input.type, 'type', 128), requireString(input.name, 'name', 1024 * 1024), input.config as never)
  })
  ipcMain.handle('article:get', (event, raw: unknown) => { guard(event); return providers.article(entryLocation(raw)) })
  ipcMain.handle('provider:fetch', (event, raw: unknown) => {
    guard(event); const input = requireRecord(raw)
    return providers.fetch({ ...entryLocation(raw), requestId: requireString(input.requestId, 'requestId', 128), settingsRevision: requireString(input.settingsRevision, 'settingsRevision', 128) })
  })
  ipcMain.handle('provider:cancel', (event, id: unknown) => { guard(event); providers.cancel(requireString(id, 'requestId', 128)) })
  ipcMain.handle('credential:save', (event, key: unknown) => { guard(event); return credentials.save(requireString(key, 'key', 16384)) })
  ipcMain.handle('credential:status', (event, ref: unknown) => { guard(event); return credentials.status(ref === undefined ? undefined : requireString(ref, 'apiKeyRef', 128)) })
  ipcMain.handle('credential:remove', (event, ref: unknown) => { guard(event); return credentials.remove(requireString(ref, 'apiKeyRef', 128)) })
  ipcMain.handle('dictionary:stats', event => { guard(event); return dictionaryCache.stats() })
  ipcMain.handle('dictionary:clear', event => { guard(event); dictionaryCache.clear(); return dictionaryCache.stats() })

  ipcMain.handle('system:open-external', async (event, rawUrl: unknown) => {
    guard(event)
    const raw = requireString(rawUrl, 'url', 8192)
    let url: URL
    try { url = new URL(raw) } catch { throw new CaretLexError('INVALID_URL', '链接格式无效。') }
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new CaretLexError('INVALID_URL', '只允许打开 http、https 或 mailto 链接。')
    await shell.openExternal(url.href)
  })

  ipcMain.handle('image:local', async (event, rawId: unknown, rawSource: unknown) => {
    guard(event)
    const id = requireString(rawId, 'documentId', 64)
    const source = requireString(rawSource, 'source', 4096)
    const image = await documents.resolveLocalImage(id, source)
    return image ? `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}` : null
  })

  ipcMain.handle('image:remote', async (event, rawUrl: unknown) => {
    guard(event)
    const raw = requireString(rawUrl, 'url', 8192)
    let url: URL
    try { url = new URL(raw) } catch { return null }
    if (!['http:', 'https:'].includes(url.protocol)) return null
    const response = await net.fetch(url.href, { signal: AbortSignal.timeout(12000) })
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return null
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > 10 * 1024 * 1024) return null
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        total += result.value.byteLength
        if (total > 10 * 1024 * 1024) {
          await reader.cancel()
          return null
        }
        chunks.push(result.value)
      }
    } finally {
      reader.releaseLock()
    }
    const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
    const mime = response.headers.get('content-type')!.split(';')[0]
    return `data:${mime};base64,${data.toString('base64')}`
  })

  ipcMain.handle('dialog:error', async (event, rawMessage: unknown) => {
    guard(event)
    if (!mainWindow) return
    await dialog.showMessageBox(mainWindow, { type: 'error', title: 'CaretLex', message: requireString(rawMessage, 'message', 4000) })
  })

  ipcMain.on('app:close-response', (event, allow: unknown) => {
    guard(event)
    if (typeof allow !== 'boolean') return
    if (allow && mainWindow) {
      closeAllowed = true
      mainWindow.close()
    }
  })
}

async function atomicOutput(path: string, bytes: Buffer): Promise<void> {
  const temp = resolve(dirname(path), `.caretlex-export-${process.pid}-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, path)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function createWindow(): void {
  closeAllowed = false
  currentMenuState = initialMenuState
  const menu = Menu.buildFromTemplate(applicationMenuTemplate({
    isMac: process.platform === 'darwin',
    development: Boolean(process.env.ELECTRON_RENDERER_URL),
    command: command => {
      // Mode checks follow the renderer's accepted state, including cancelled switches.
      updateApplicationMenu(menu, currentMenuState)
      mainWindow?.webContents.send('menu:command', command)
    },
    about: () => {
      if (mainWindow) void dialog.showMessageBox(mainWindow, {
        type: 'info', title: '关于 CaretLex', message: 'CaretLex',
        detail: `版本 ${app.getVersion()}\n英文 Markdown 阅读与文档内词条笔记。`, buttons: ['确定']
      })
    }
  }))
  updateApplicationMenu(menu, initialMenuState)
  Menu.setApplicationMenu(menu)
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 850,
    minWidth: 850,
    minHeight: 620,
    show: false,
    icon: windowIconPath(),
    backgroundColor: '#f4f6f8',
    webPreferences: {
      preload: resolve(moduleDirectory, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  mainWindow.on('close', (event) => {
    if (closeAllowed) return
    event.preventDefault()
    mainWindow?.webContents.send('app:request-close')
  })
  mainWindow.on('closed', () => { mainWindow = undefined })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(resolve(moduleDirectory, '../renderer/index.html'))
}

function publishSettings(): void {
  if (!mainWindow) return
  mainWindow.webContents.send('settings:changed', settings.status())
}

app.whenReady().then(() => {
  if (!singleInstance) return
  if (process.platform === 'linux') {
    // Wayland 任务栏按 app_id 匹配已安装的 .desktop；缺失时补一份用户级条目与图标。
    void ensureLinuxDesktopEntry({ execPath: process.execPath, sourceIcon: windowIconPath(), dataHome: xdgDataHome() })
      .catch(error => console.warn('桌面条目安装失败：', error))
  }
  settings = new SettingsRepository(app.getPath('userData'))
  credentials = new CredentialRepository(app.getPath('userData'))
  dictionaryCache = new DictionaryCache(resolve(app.getPath('userData'), 'dictionary.sqlite'))
  const dictionary = createDictionaryClient({ fetch: globalThis.fetch, getKey: ref => credentials.get(ref), cache: dictionaryCache })
  const llm = createLlmAdapter({ fetch: globalThis.fetch, getKey: ref => credentials.get(ref), dictionary })
  providers = new ProviderService(documents, settings, new Map([['LLM', llm]]))
  settings.setChangeListener(() => { providers.cancelAll(); publishSettings() })
  documents.setChangeListener(sendDocument)
  registerHandlers()
  createWindow()
  if (process.platform === 'darwin') app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('second-instance', async (_event, argv) => {
  const path = argv.find((arg) => /\.md(?:own)?$/i.test(arg) && !arg.startsWith('-'))
  if (path) {
    try { const opened = await documents.open(path); sendDocument(opened.snapshot.id, opened) }
    catch (error) { await mainWindow?.webContents.send('app:open-error', String(error)) }
  }
  mainWindow?.focus()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { dictionaryCache?.close() })

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()
