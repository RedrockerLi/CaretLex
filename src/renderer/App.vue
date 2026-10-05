<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ReaderView from './components/ReaderView.vue'
import SettingsView from './components/SettingsView.vue'
import SourceEditor from './components/SourceEditor.vue'
import { useWorkspaceStore } from './stores/workspace'
import type { JsonValue, WorkspaceTab } from './types'
import { defaultSettings } from '../shared/settings'

const workspace = useWorkspaceStore()
const systemDark = ref(window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
const settingsOpen = computed(() => workspace.settingsOpen)
const activeTab = computed(() => workspace.activeTab)
const currentTheme = computed(() => workspace.theme)
const effectiveDark = computed(() => currentTheme.value === 'dark' || (currentTheme.value === 'system' && systemDark.value))
const runtimeSettings = computed(() => workspace.settingsExternal ?? workspace.settingsSnapshot)
const credentialDraft = ref(false)
const settingsValue = computed(() => runtimeSettings.value?.value ?? null)
const settingsForReader = computed(() => settingsValue.value ?? defaultSettings)
const settingsAvailable = computed(() => settingsValue.value !== null)
const pendingAction = computed(() => workspace.pendingAction)
const pendingEntryDraft = computed(() => pendingAction.value?.kind === 'close-window' ? Object.values(workspace.entryDrafts).some(Boolean) || credentialDraft.value : pendingAction.value && workspace.entryDrafts[pendingAction.value.tabId])
let unwatchDocuments: (() => void) | undefined
let unwatchSettings: (() => void) | undefined
let unwatchClose: (() => void) | undefined
let mediaQuery: MediaQueryList | undefined

function applyTheme() {
  document.documentElement.dataset.theme = effectiveDark.value ? 'dark' : 'light'
}

function onSystemTheme(event: MediaQueryListEvent) {
  systemDark.value = event.matches
}

async function showOpen() { await workspace.openMarkdown() }
async function showNew() { await workspace.newDocument() }

function openSettings() {
  workspace.settingsOpen = true
  if (!workspace.settingsSnapshot) void workspace.loadSettings()
}

async function toggleTheme() {
  if (!workspace.settingsSnapshot) await workspace.loadSettings()
  const current = workspace.settingsSnapshot?.value
  if (!current) return
  const nextTheme = effectiveDark.value ? 'light' : 'dark'
  await workspace.saveSettings({ ...current, theme: nextTheme })
}

async function saveCurrent(tab = activeTab.value, as = false) {
  if (!tab) return false
  return workspace.saveSource(tab.id, as)
}

function switchMode(tab: WorkspaceTab) {
  if (tab.mode === 'source') {
    if (tab.dirty) workspace.pendingAction = { kind: 'switch-mode', tabId: tab.id, mode: 'read' }
    else workspace.setMode(tab.id, 'read')
  } else {
    workspace.setMode(tab.id, 'source')
  }
}

function requestCloseTab(tab: WorkspaceTab) {
  if (tab.dirty || workspace.entryDrafts[tab.id]) workspace.pendingAction = { kind: 'close-tab', tabId: tab.id }
  else releaseTab(tab)
}

function releaseTab(tab: WorkspaceTab) {
  workspace.closeTab(tab.id)
  if (!workspace.tabs.some((item) => item.id === tab.id)) {
    void window.caretlex.closeDocument(tab.id).catch((error) => {
      workspace.bridgeError = error instanceof Error ? error.message : '关闭文档会话失败。'
    })
  }
}

async function closeAllDocuments() {
  const documentIds = workspace.tabs.map((tab) => tab.id)
  await Promise.all(documentIds.map((id) => window.caretlex.closeDocument(id).catch((error) => {
    workspace.bridgeError = error instanceof Error ? error.message : '关闭文档会话失败。'
  })))
  window.caretlex.respondToClose(true)
}

async function handlePending(choice: 'save' | 'discard' | 'cancel') {
  const action = workspace.pendingAction
  if (!action) return
  if (choice === 'cancel') {
    workspace.pendingAction = null
    if (action.kind === 'close-window') window.caretlex.respondToClose(false)
    return
  }

  if (choice === 'save' && (action.kind === 'close-window' ? Object.values(workspace.entryDrafts).some(Boolean) || credentialDraft.value : workspace.entryDrafts[action.tabId])) {
    workspace.pendingAction = null
    if (action.kind === 'close-window') window.caretlex.respondToClose(false)
    return
  }
  const affected = action.kind === 'close-window'
    ? workspace.tabs.filter((tab) => tab.dirty)
    : workspace.tabs.filter((tab) => tab.id === action.tabId && tab.dirty)
  if (choice === 'save') {
    for (const tab of affected) {
      if (!(await workspace.saveSource(tab.id))) return
    }
    if (action.kind === 'close-window' && workspace.settingsDirty && !(await workspace.saveSettingsDraft())) return
  } else {
    for (const tab of affected) workspace.updateDraft(tab.id, tab.document.snapshot.text)
    if (action.kind === 'close-window' && workspace.settingsDirty) {
      if (workspace.settingsExternal) workspace.reloadExternalSettings()
      else if (workspace.settingsSnapshot) workspace.updateSettingsDraft(workspace.settingsSnapshot.text ?? '')
    }
  }

  workspace.pendingAction = null
  if (action.kind === 'close-tab') {
    const tab = workspace.tabs.find((item) => item.id === action.tabId)
    if (tab) releaseTab(tab)
  } else if (action.kind === 'switch-mode') {
    workspace.setMode(action.tabId, 'read')
  } else if (action.kind === 'close-window') {
    await closeAllDocuments()
  }
}

async function deleteVocabulary(lemma: string) {
  if (!activeTab.value) return
  const done = await workspace.deleteVocabulary(activeTab.value.id, lemma)
  if (!done && workspace.bridgeError) await window.caretlex.showError(workspace.bridgeError)
}

async function exportVocabulary() {
  if (!activeTab.value) return
  const result = await workspace.exportVocabulary(activeTab.value.id)
  if (result?.kind === 'saved') workspace.bridgeError = `已导出到 ${result.path}`
}

function tabTitle(tab: WorkspaceTab) {
  if (!tab.document.snapshot.path) return '未命名文档'
  return tab.document.snapshot.path.split(/[\\/]/).filter(Boolean).at(-1) ?? tab.document.snapshot.path
}

onMounted(async () => {
  applyTheme()
  mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)')
  mediaQuery?.addEventListener('change', onSystemTheme)
  unwatchDocuments = window.caretlex.onDocumentChanged((event) => workspace.applyExternalChange(event.document))
  unwatchSettings = window.caretlex.onSettingsChanged((snapshot) => workspace.applyExternalSettings(snapshot))
  unwatchClose = window.caretlex.onRequestClose(() => {
    if (workspace.tabs.some((tab) => tab.dirty) || workspace.settingsDirty || credentialDraft.value || Object.values(workspace.entryDrafts).some(Boolean)) workspace.pendingAction = { kind: 'close-window' }
    else void closeAllDocuments()
  })
  await workspace.openStartupDocument()
  await workspace.loadSettings()
})

watch(effectiveDark, applyTheme, { immediate: true })

onBeforeUnmount(() => {
  unwatchDocuments?.()
  unwatchSettings?.()
  unwatchClose?.()
  mediaQuery?.removeEventListener('change', onSystemTheme)
})
</script>

<template>
  <main class="app-shell" :class="{ 'is-dark': effectiveDark }">
    <header class="app-toolbar">
      <div class="brand-mark" aria-label="CaretLex">[<span>^</span>w-]</div>
      <div class="toolbar-divider"></div>
      <button class="toolbar-button" type="button" :disabled="workspace.busy" @click="showNew">新建</button>
      <button class="toolbar-button" type="button" :disabled="workspace.busy" @click="showOpen">打开 Markdown</button>
      <template v-if="activeTab">
        <span class="toolbar-spacer"></span>
        <button class="toolbar-button" type="button" :class="{ selected: activeTab.mode === 'read' }" @click="switchMode(activeTab)">阅读</button>
        <button class="toolbar-button" type="button" :class="{ selected: activeTab.mode === 'source' }" @click="switchMode(activeTab)">源码</button>
        <button v-if="activeTab.mode === 'source'" class="button button-primary button-small" type="button" :disabled="workspace.busy || !activeTab.dirty" @click="saveCurrent(activeTab)">保存源码</button>
        <button v-if="activeTab.mode === 'read'" class="toolbar-button" type="button" :disabled="!activeTab.document.parsed.writable || workspace.busy" @click="exportVocabulary">导出 JSON</button>
      </template>
      <span class="toolbar-spacer"></span>
      <button class="icon-button theme-toggle" type="button" :aria-label="effectiveDark ? '切换浅色主题' : '切换深色主题'" @click="toggleTheme">{{ effectiveDark ? '☼' : '◐' }}</button>
      <button class="toolbar-button settings-trigger" type="button" @click="openSettings">设置</button>
    </header>

    <nav v-if="workspace.tabs.length" class="tab-strip" aria-label="打开的文档">
      <div v-for="tab in workspace.tabs" :key="tab.id" class="document-tab" :class="{ active: tab.id === workspace.activeTabId }" @click="workspace.activeTabId = tab.id">
        <span class="tab-title">{{ tabTitle(tab) }}</span>
        <span v-if="tab.dirty" class="dirty-dot" aria-label="未保存"></span>
        <span v-if="tab.externalConflict" class="conflict-dot" aria-label="磁盘文件已更改" title="磁盘文件已更改"></span>
        <button class="tab-close" type="button" :aria-label="`关闭 ${tabTitle(tab)}`" @click.stop="requestCloseTab(tab)">×</button>
      </div>
    </nav>

    <section v-if="workspace.bridgeError" class="global-message" role="status">
      <span>{{ workspace.bridgeError }}</span>
      <button class="text-button" type="button" @click="workspace.bridgeError = ''">关闭</button>
    </section>

    <section v-if="activeTab && activeTab.externalConflict" class="conflict-banner" role="alert">
      <span>磁盘文件已被外部修改。当前草稿仍保留；保存会因版本冲突而被拒绝。</span>
      <button class="button button-secondary button-small" type="button" @click="workspace.reloadExternal(activeTab.id)">重新加载磁盘版本</button>
    </section>

    <section class="settings-overlay" v-show="settingsOpen">
      <SettingsView
        :snapshot="workspace.settingsSnapshot"
        :external-snapshot="workspace.settingsExternal"
        :draft="workspace.settingsDraft"
        :dirty="workspace.settingsDirty"
        :error="workspace.bridgeError"
        :on-save="workspace.saveSettings"
        :on-reset="workspace.resetSettings"
        :on-choose-path="workspace.migrateSettingsPath"
        :on-reload-external="workspace.reloadExternalSettings"
        @update:draft="workspace.updateSettingsDraft"
        @credentials-dirty="credentialDraft = $event"
        @close="workspace.settingsOpen = false"
      />
    </section>
    <section v-for="tab in workspace.tabs" :key="tab.id" v-show="!settingsOpen && activeTab?.id === tab.id" class="document-workspace">
      <SourceEditor v-if="tab.mode === 'source'" :model-value="tab.draft" :dark="effectiveDark" @update:model-value="workspace.updateDraft(tab.id, $event)" @save="saveCurrent(tab)" />
      <ReaderView v-show="tab.mode === 'read'" :tab="tab" :active="!settingsOpen && activeTab?.id === tab.id && tab.mode === 'read'" :busy="workspace.busy" :dark="effectiveDark"
        :settings="settingsForReader" :settings-available="settingsAvailable" :settings-revision="runtimeSettings?.revision ?? ''"
        :on-save-entry="workspace.addVocabulary" :on-edit-entry="workspace.editVocabulary" :on-delete-entry="workspace.deleteVocabulary"
        @unsaved="workspace.entryDrafts[tab.id] = $event" />
      <footer v-if="tab.mode === 'source'" class="document-statusbar"><span>{{ tab.document.snapshot.path || '新文档尚未保存' }}</span><span>{{ tab.dirty ? '有未保存修改' : '已保存' }}</span></footer>
    </section>
    <section v-if="!settingsOpen && !activeTab" class="welcome-screen">
      <div class="welcome-logo">[<span>^</span>w-]</div>
      <p class="eyebrow">CARETLEX</p>
      <h1>让词条留在 Markdown 里</h1>
      <p class="welcome-copy">打开一篇英文文档，选中单词并检查释义。词条会写入文档，随文件一起携带。</p>
      <div class="welcome-actions">
        <button class="button button-primary" type="button" :disabled="workspace.busy" @click="showOpen">打开 Markdown</button>
        <button class="button button-secondary" type="button" :disabled="workspace.busy" @click="showNew">新建文档</button>
      </div>
      <p class="welcome-footnote">可手动填写，或在设置中启用一个自动 provider；词条身份由你确认。</p>
    </section>

    <div v-if="pendingAction" class="modal-backdrop" role="presentation">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="pending-title">
        <h2 id="pending-title">{{ pendingAction.kind === 'close-window' ? '关闭窗口？' : pendingAction.kind === 'close-tab' ? '关闭标签页？' : '切回阅读模式？' }}</h2>
        <p v-if="pendingEntryDraft">词条、设置或凭据有未保存草稿。返回编辑界面检查并保存，或放弃草稿继续关闭。</p>
        <p v-else>{{ pendingAction.kind === 'close-window' && workspace.settingsDirty ? '文档或设置中有未保存的修改。保存后继续、放弃修改，或取消关闭。' : '源码中有未保存的修改。保存后继续、放弃修改，或取消当前操作。' }}</p>
        <div class="dialog-actions">
          <button class="button button-secondary" type="button" @click="handlePending('cancel')">取消</button>
          <button class="button button-danger" type="button" @click="handlePending('discard')">放弃修改</button>
          <button class="button button-primary" type="button" @click="handlePending('save')">{{ pendingEntryDraft ? '返回编辑' : '保存并继续' }}</button>
        </div>
      </section>
    </div>
  </main>
</template>
