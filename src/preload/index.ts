import { contextBridge, ipcRenderer } from 'electron'
import { isJsonValue } from '../shared/json'
import type { CaretLexBridge } from '../shared/bridge'

const documentHandlers = new Set<Parameters<CaretLexBridge['onDocumentChanged']>[0]>()
const pendingDocuments: Parameters<CaretLexBridge['onDocumentChanged']>[0] extends (arg: infer T) => void ? T[] : never[] = []

function copyJson(value: unknown): unknown {
  if (!isJsonValue(value)) throw new TypeError('IPC 只接受有限、可序列化 JSON。')
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('IPC 只接受有效 JSON 值。')
  return JSON.parse(serialized)
}

ipcRenderer.on('document:changed', (_event, payload) => {
  if (documentHandlers.size === 0) {
    pendingDocuments.push(payload)
    return
  }
  for (const handler of documentHandlers) handler(payload)
})

const bridge: CaretLexBridge = {
  providerTypes: () => ipcRenderer.invoke('provider:types'),
  providerPreset: input => ipcRenderer.invoke('provider:preset', { ...input, config: copyJson(input.config) }),
  getArticle: input => ipcRenderer.invoke('article:get', input),
  fetchSources: input => ipcRenderer.invoke('provider:fetch', input),
  cancelProvider: id => ipcRenderer.invoke('provider:cancel', id),
  saveCredential: key => ipcRenderer.invoke('credential:save', key),
  credentialStatus: ref => ipcRenderer.invoke('credential:status', ref),
  takeStartupDocument: () => ipcRenderer.invoke('document:startup'),
  openMarkdown: () => ipcRenderer.invoke('document:open'),
  newDocument: () => ipcRenderer.invoke('document:new'),
  closeDocument: (documentId) => ipcRenderer.invoke('document:close', documentId),
  saveSource: (input) => ipcRenderer.invoke('document:save-source', input),
  saveAs: (input) => ipcRenderer.invoke('document:save-as', input),
  addVocabulary: (input) => ipcRenderer.invoke('vocab:add', {
    ...input,
    sourceSpan: { start: input.sourceSpan.start, end: input.sourceSpan.end },
    value: copyJson(input.value),
  }),
  editVocabulary: (input) => ipcRenderer.invoke('vocab:edit', { ...input, value: copyJson(input.value) }),
  deleteVocabulary: (input) => ipcRenderer.invoke('vocab:delete', input),
  exportCurrentVocabulary: (documentId) => ipcRenderer.invoke('vocab:export', documentId),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', { ...input, value: copyJson(input.value) }),
  resetSettings: token => ipcRenderer.invoke('settings:reset', token),
  chooseSettingsPath: () => ipcRenderer.invoke('settings:migrate'),
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  loadLocalImage: (documentId, source) => ipcRenderer.invoke('image:local', documentId, source),
  loadRemoteImage: (url) => ipcRenderer.invoke('image:remote', url),
  onDocumentChanged(callback) {
    documentHandlers.add(callback)
    for (const payload of pendingDocuments.splice(0)) callback(payload)
    return () => documentHandlers.delete(callback)
  },
  onSettingsChanged(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },
  onRequestClose(callback) {
    const listener = () => callback()
    ipcRenderer.on('app:request-close', listener)
    return () => ipcRenderer.removeListener('app:request-close', listener)
  },
  respondToClose: (allow) => ipcRenderer.send('app:close-response', allow),
  showError: (message) => ipcRenderer.invoke('dialog:error', message)
}

contextBridge.exposeInMainWorld('caretlex', bridge)
