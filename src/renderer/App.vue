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
const settingsValue = computed(() => workspace.settingsSnapshot?.value ?? null)
const settingsForReader = computed(() => settingsValue.value ?? defaultSettings)
const settingsAvailable = computed(() => settingsValue.value !== null)
const entryTemplate = computed<JsonValue>(() => settingsValue.value?.entryTemplate ?? defaultSettings.entryTemplate)

function isDefaultBindings(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const bindings = value as Record<string, unknown>
  const word = bindings['/word'] as Record<string, unknown> | undefined
  const translation = bindings['/translation'] as Record<string, unknown> | undefined
  const example = bindings['/example'] as Record<string, unknown> | undefined
  return word?.from === 'lemma'
    && translation?.from === 'manual'
    && translation.required === true
    && example?.from === 'sentence'
    && Object.keys(bindings).length === 3
}

const defaultBindings = computed(() => {
  if (!settingsValue.value) return false
  const template = entryTemplate.value
  if (!template || typeof template !== 'object' || Array.isArray(template)) return false
  const keys = Object.keys(template)
  return keys.join(',') === 'word,translation,example'
    && isDefaultBindings(settingsValue.value.bindings)
})

const pendingAction = computed(() => workspace.pendingAction)
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
  if (tab.dirty) workspace.pendingAction = { kind: 'close-tab', tabId: tab.id }
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
      else if (workspace.settingsSnapshot) workspace.updateSettingsDraft(JSON.stringify(workspace.settingsSnapshot.value, null, 2))
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

async function addVocabulary(selection: { sourceSpan: { start: number; end: number }; selected: string; sentence: string }, lemma: string, value: JsonValue, complete: (saved: boolean) => void) {
  const tab = activeTab.value
  if (!tab) { complete(false); return }
  const saved = await workspace.addVocabulary(tab, { sourceSpan: selection.sourceSpan, selected: selection.selected, lemma, value })
  complete(saved)
}

async function editVocabulary(lemma: string, value: JsonValue) {
  if (!activeTab.value) return
  await workspace.editVocabulary(activeTab.value.id, lemma, value)
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
    if (workspace.tabs.some((tab) => tab.dirty) || workspace.settingsDirty) workspace.pendingAction = { kind: 'close-window' }
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
        :on-choose-path="workspace.migrateSettingsPath"
        :on-reload-external="workspace.reloadExternalSettings"
        @update:draft="workspace.updateSettingsDraft"
        @close="workspace.settingsOpen = false"
      />
    </section>
    <section v-if="!settingsOpen && activeTab" class="document-workspace">
      <SourceEditor
        v-if="activeTab.mode === 'source'"
        :model-value="activeTab.draft"
        :dark="effectiveDark"
        @update:model-value="workspace.updateDraft(activeTab.id, $event)"
        @save="saveCurrent(activeTab)"
      />
      <ReaderView
        v-else
        :key="`${activeTab.id}:${activeTab.document.snapshot.revision ?? 'draft'}`"
        :tab="activeTab"
        :busy="workspace.busy"
        :dark="effectiveDark"
        :settings="settingsForReader"
        :settings-available="settingsAvailable"
        :template="entryTemplate"
        :default-bindings="defaultBindings"
        @add="addVocabulary"
        @edit="editVocabulary"
        @delete="deleteVocabulary"
      />
      <footer v-if="activeTab.mode === 'source'" class="document-statusbar">
        <span>{{ activeTab.document.snapshot.path || '新文档尚未保存' }}</span>
        <span>{{ activeTab.dirty ? '有未保存修改' : '已保存' }}</span>
      </footer>
    </section>
    <section v-else-if="!settingsOpen" class="welcome-screen">
      <div class="welcome-logo">[<span>^</span>w-]</div>
      <p class="eyebrow">CARETLEX</p>
      <h1>让词条留在 Markdown 里</h1>
      <p class="welcome-copy">打开一篇英文文档，选中单词并手动保存释义。词条会写入文档，随文件一起携带。</p>
      <div class="welcome-actions">
        <button class="button button-primary" type="button" :disabled="workspace.busy" @click="showOpen">打开 Markdown</button>
        <button class="button button-secondary" type="button" :disabled="workspace.busy" @click="showNew">新建文档</button>
      </div>
      <p class="welcome-footnote">首版词条由你确认，不接入自动词典。</p>
    </section>

    <div v-if="pendingAction" class="modal-backdrop" role="presentation">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="pending-title">
        <h2 id="pending-title">{{ pendingAction.kind === 'close-window' ? '关闭窗口？' : pendingAction.kind === 'close-tab' ? '关闭标签页？' : '切回阅读模式？' }}</h2>
        <p>{{ pendingAction.kind === 'close-window' && workspace.settingsDirty ? '文档或设置中有未保存的修改。保存后继续、放弃修改，或取消关闭。' : '源码中有未保存的修改。保存后继续、放弃修改，或取消当前操作。' }}</p>
        <div class="dialog-actions">
          <button class="button button-secondary" type="button" @click="handlePending('cancel')">取消</button>
          <button class="button button-danger" type="button" @click="handlePending('discard')">放弃修改</button>
          <button class="button button-primary" type="button" @click="handlePending('save')">保存并继续</button>
        </div>
      </section>
    </div>
  </main>
</template>
