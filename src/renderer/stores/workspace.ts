import { computed, ref, shallowReactive, shallowRef, triggerRef } from 'vue'
import { defineStore } from 'pinia'
import { documentFromWire } from '../../shared/document-wire'
import { parseSettings } from '../../shared/settings'
import type { DocumentResult, JsonValue, PendingAction, SaveResult, SettingsSnapshot, WorkspaceDocument, WorkspaceTab } from '../types'

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function decodeDocument(result: DocumentResult): WorkspaceDocument {
  return documentFromWire(result)
}

function makeTab(result: DocumentResult): WorkspaceTab {
  const document = decodeDocument(result)
  return shallowReactive<WorkspaceTab>({
    id: document.snapshot.id,
    document,
    mode: 'read',
    draft: document.snapshot.text,
    dirty: false,
    externalConflict: false,
    pendingExternal: undefined,
  })
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const tabs = shallowRef<WorkspaceTab[]>([])
  const activeTabId = ref<string | null>(null)
  const settingsOpen = ref(false)
  const settingsSnapshot = shallowRef<SettingsSnapshot | null>(null)
  const settingsExternal = shallowRef<SettingsSnapshot | null>(null)
  const settingsDraft = ref('')
  const settingsDirty = ref(false)
  const pendingAction = ref<PendingAction | null>(null)
  const bridgeError = ref('')
  const busy = ref(false)
  const entryDrafts = ref<Record<string, boolean>>({})

  const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value) ?? null)
  const theme = computed(() => (settingsExternal.value ?? settingsSnapshot.value)?.value?.theme ?? 'system')

  function applyDocument(result: DocumentResult) {
    const existing = tabs.value.find((tab) => tab.id === result.snapshot.id)
    if (existing) {
      const previousRevision = existing.document.snapshot.revision
      if (existing.dirty) {
        if (result.snapshot.revision !== previousRevision) {
          existing.externalConflict = true
          existing.pendingExternal = decodeDocument(result)
        }
        triggerRef(tabs)
        activeTabId.value = existing.id
        return existing
      }
      existing.document = decodeDocument(result)
      existing.draft = result.snapshot.text
      existing.externalConflict = false
      existing.pendingExternal = undefined
      triggerRef(tabs)
      activeTabId.value = existing.id
      return existing
    }
    const tab = makeTab(result)
    tabs.value.push(tab)
    triggerRef(tabs)
    activeTabId.value = tab.id
    return tab
  }

  function applySave(tab: WorkspaceTab, result: SaveResult) {
    tab.document = decodeDocument(result)
    tab.draft = result.snapshot.text
    tab.dirty = false
    tab.externalConflict = false
    tab.pendingExternal = undefined
    triggerRef(tabs)
  }

  async function openMarkdown() {
    bridgeError.value = ''
    busy.value = true
    try {
      const result = await window.caretlex.openMarkdown()
      if (result) applyDocument(result)
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '打开文档失败。'
    } finally {
      busy.value = false
    }
  }

  async function openStartupDocument() {
    try {
      const result = await window.caretlex.takeStartupDocument()
      if (result) applyDocument(result)
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '打开启动文档失败。'
    }
  }

  async function newDocument() {
    bridgeError.value = ''
    busy.value = true
    try {
      applyDocument(await window.caretlex.newDocument())
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '新建文档失败。'
    } finally {
      busy.value = false
    }
  }

  function updateDraft(tabId: string, text: string) {
    const tab = tabs.value.find((item) => item.id === tabId)
    if (!tab) return
    tab.draft = text
    tab.dirty = text !== tab.document.snapshot.text
    triggerRef(tabs)
  }

  async function saveSource(tabId: string, saveAs = false) {
    const tab = tabs.value.find((item) => item.id === tabId)
    if (!tab) return false
    bridgeError.value = ''
    busy.value = true
    try {
      const result = saveAs || !tab.document.snapshot.path
        ? await window.caretlex.saveAs({
            documentId: tab.id,
            baseRevision: tab.document.snapshot.revision,
            text: tab.draft,
          })
        : await window.caretlex.saveSource({
            documentId: tab.id,
            baseRevision: tab.document.snapshot.revision,
            text: tab.draft,
          })
      if (!result) return false
      applySave(tab, result)
      return true
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '保存失败，草稿仍保留。'
      return false
    } finally {
      busy.value = false
    }
  }

  function applyExternalChange(result: DocumentResult) {
    const document = decodeDocument(result)
    const tab = tabs.value.find((item) => item.id === document.snapshot.id)
    if (!tab) return
    if (tab.dirty) {
      tab.externalConflict = true
      tab.pendingExternal = document
      triggerRef(tabs)
      return
    }
    tab.document = document
    tab.draft = document.snapshot.text
    tab.externalConflict = false
    tab.pendingExternal = undefined
    triggerRef(tabs)
  }

  function reloadExternal(tabId: string) {
    const tab = tabs.value.find((item) => item.id === tabId)
    if (!tab) return
    if (tab.pendingExternal) tab.document = tab.pendingExternal
    tab.draft = tab.document.snapshot.text
    tab.dirty = false
    tab.externalConflict = false
    tab.pendingExternal = undefined
    triggerRef(tabs)
  }

  function closeTab(tabId: string) {
    const index = tabs.value.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    tabs.value.splice(index, 1)
    delete entryDrafts.value[tabId]
    triggerRef(tabs)
    if (activeTabId.value === tabId) activeTabId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id ?? null
  }

  function setMode(tabId: string, mode: 'read' | 'source') {
    const tab = tabs.value.find((item) => item.id === tabId)
    if (!tab) return
    tab.mode = mode
    if (mode === 'source' && !tab.dirty) tab.draft = tab.document.snapshot.text
    triggerRef(tabs)
  }

  async function loadSettings() {
    bridgeError.value = ''
    try {
      const snapshot = await window.caretlex.loadSettings()
      if (settingsDirty.value && settingsSnapshot.value?.revision !== snapshot.revision) {
        settingsExternal.value = snapshot
        return
      }
      settingsSnapshot.value = snapshot
      settingsDraft.value = snapshot.text ?? ''
      settingsDirty.value = false
      settingsExternal.value = null
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '读取设置失败。'
    }
  }

  function updateSettingsDraft(value: string) {
    settingsDraft.value = value
    settingsDirty.value = settingsSnapshot.value
      ? value !== (settingsSnapshot.value.text ?? '')
      : value.length > 0
  }

  async function saveSettings(value: unknown) {
    if (!settingsSnapshot.value) return false
    bridgeError.value = ''
    try {
      const snapshot = await window.caretlex.saveSettings({
        value: cloneJson(value as JsonValue),
        baseRevision: settingsSnapshot.value.revision,
      })
      settingsSnapshot.value = snapshot
      if (snapshot.error) return false
      settingsDraft.value = snapshot.text ?? ''
      settingsDirty.value = false
      settingsExternal.value = null
      return true
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '保存设置失败。'
      return false
    }
  }

  async function saveSettingsDraft() {
    let value: unknown
    try {
      value = JSON.parse(settingsDraft.value)
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '设置 JSON 格式无效。'
      return false
    }
    const parsed = parseSettings(JSON.stringify(value))
    if (!parsed.ok) {
      bridgeError.value = parsed.error.message
      return false
    }
    return saveSettings(parsed.value)
  }

  function applyExternalSettings(snapshot: SettingsSnapshot) {
    if (settingsDirty.value) {
      settingsExternal.value = snapshot
      return
    }
    settingsSnapshot.value = snapshot
    settingsDraft.value = snapshot.text ?? ''
    settingsDirty.value = false
    settingsExternal.value = null
  }

  async function resetSettings() {
    const token = (settingsExternal.value ?? settingsSnapshot.value)?.resetToken
    if (!token) { bridgeError.value = '当前设置文件无法安全写入，请检查文件权限或重新选择位置。'; return false }
    bridgeError.value = ''
    try {
      const snapshot = await window.caretlex.resetSettings(token)
      settingsSnapshot.value = snapshot; settingsExternal.value = null
      settingsDraft.value = snapshot.text ?? ''; settingsDirty.value = false
      return !snapshot.error
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '恢复默认设置失败。'
      settingsExternal.value = await window.caretlex.loadSettings().catch(() => null)
      return false
    }
  }

  function reloadExternalSettings() {
    const snapshot = settingsExternal.value
    if (!snapshot) return false
    settingsSnapshot.value = snapshot
    settingsDraft.value = snapshot.text ?? ''
    settingsDirty.value = false
    settingsExternal.value = null
    return true
  }

  async function migrateSettingsPath() {
    if (settingsDirty.value) {
      bridgeError.value = '请先保存设置草稿，再迁移设置文件。'
      return
    }
    bridgeError.value = ''
    try {
      const result = await window.caretlex.chooseSettingsPath()
      if (result) {
        settingsSnapshot.value = result
        settingsDraft.value = result.text ?? ''
        settingsExternal.value = null
      }
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '迁移设置文件失败。'
    }
  }

  async function exportVocabulary(tabId: string) {
    bridgeError.value = ''
    try {
      return await window.caretlex.exportCurrentVocabulary(tabId)
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '导出失败。'
      return null
    }
  }

  async function addVocabulary(location: import('../../shared/bridge').EntryLocation, lemma: string, value: JsonValue) {
    const tab = tabs.value.find(item => item.id === location.documentId)
    if (!tab) throw new Error('文档会话已关闭，草稿未保存。')
    bridgeError.value = ''; busy.value = true
    try {
      const result = await window.caretlex.addVocabulary(cloneJson({ ...location, lemma, value }))
      applySave(tab, result)
      return result
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '保存词条失败。'
      throw error
    } finally { busy.value = false }
  }
  async function editVocabulary(documentId: string, baseRevision: string | undefined, lemma: string, value: JsonValue) {
    const tab = tabs.value.find(item => item.id === documentId)
    if (!tab) throw new Error('文档会话已关闭，草稿未保存。')
    bridgeError.value = ''; busy.value = true
    try {
      const result = await window.caretlex.editVocabulary({ documentId, baseRevision, lemma, value: cloneJson(value) })
      applySave(tab, result)
      return result
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '编辑词条失败。'
      throw error
    } finally { busy.value = false }
  }

  async function deleteVocabulary(tabId: string, lemma: string, baseRevision?: string) {
    const tab = tabs.value.find((item) => item.id === tabId)
    if (!tab) return false
    bridgeError.value = ''
    busy.value = true
    try {
      const result = await window.caretlex.deleteVocabulary({ documentId: tab.id, baseRevision: baseRevision ?? tab.document.snapshot.revision, lemma })
      applySave(tab, result)
      return true
    } catch (error) {
      bridgeError.value = error instanceof Error ? error.message : '删除词条失败。'
      return false
    } finally {
      busy.value = false
    }
  }

  return {
    tabs,
    entryDrafts,
    activeTabId,
    activeTab,
    theme,
    settingsOpen,
    settingsSnapshot,
    settingsExternal,
    settingsDraft,
    settingsDirty,
    pendingAction,
    bridgeError,
    busy,
    applyDocument,
    applyExternalChange,
    openMarkdown,
    openStartupDocument,
    newDocument,
    updateDraft,
    saveSource,
    reloadExternal,
    closeTab,
    setMode,
    loadSettings,
    updateSettingsDraft,
    saveSettings,
    saveSettingsDraft,
    resetSettings,
    applyExternalSettings,
    reloadExternalSettings,
    migrateSettingsPath,
    exportVocabulary,
    addVocabulary,
    editVocabulary,
    deleteVocabulary,
  }
})
