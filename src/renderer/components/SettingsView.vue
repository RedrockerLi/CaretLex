<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SettingsSnapshot } from '../types'

const props = defineProps<{
  snapshot: SettingsSnapshot | null
  externalSnapshot: SettingsSnapshot | null
  draft: string
  dirty: boolean
  error: string
  onSave: (value: unknown) => Promise<boolean>
  onChoosePath: () => Promise<void>
  onReloadExternal: () => void
}>()
const emit = defineEmits<{ close: []; 'update:draft': [value: string] }>()

const source = ref(props.draft)
const localError = ref('')
const saving = ref(false)
const theme = ref<'system' | 'light' | 'dark'>('system')

watch(() => props.draft, (draft) => { source.value = draft }, { immediate: true })
watch(source, (draft) => emit('update:draft', draft))
watch(() => props.snapshot?.revision, () => {
  if (!props.snapshot) return
  theme.value = props.snapshot.value.theme
  localError.value = ''
}, { immediate: true })

const preview = computed(() => {
  try {
    const value = JSON.parse(source.value) as Record<string, unknown>
    return JSON.stringify(value.entryTemplate, null, 2) ?? '未设置模板'
  } catch {
    return 'JSON 尚未通过解析'
  }
})

function changeTheme(nextTheme: 'system' | 'light' | 'dark') {
  try {
    const value = JSON.parse(source.value) as Record<string, unknown>
    value.theme = nextTheme
    source.value = JSON.stringify(value, null, 2)
    theme.value = nextTheme
    localError.value = ''
  } catch {
    localError.value = '请先修正设置 JSON，再修改主题。'
  }
}

async function save() {
  localError.value = ''
  let value: unknown
  try {
    value = JSON.parse(source.value)
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'JSON 格式无效。'
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    localError.value = '设置根值必须是 JSON 对象。'
    return
  }
  const settings = value as Record<string, unknown>
  if (settings.version !== 1) {
    localError.value = '当前只支持 version: 1。'
    return
  }
  if (!['system', 'light', 'dark'].includes(String(settings.theme))) {
    localError.value = 'theme 必须为 system、light 或 dark。'
    return
  }
  if (!Array.isArray(settings.providers) || settings.providers.length !== 1 || settings.providers[0] !== 'manual') {
    localError.value = '首版 providers 固定为 ["manual"]。'
    return
  }
  saving.value = true
  try {
    if (!(await props.onSave(value))) localError.value = props.error || props.snapshot?.error || '设置未保存。'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="settings-page" aria-labelledby="settings-title">
    <header class="settings-heading">
      <div>
        <p class="eyebrow">CARETLEX</p>
        <h1 id="settings-title">设置 <small v-if="dirty" class="settings-dirty-label">未保存</small></h1>
      </div>
      <button class="icon-button" type="button" aria-label="关闭设置" @click="emit('close')">×</button>
    </header>

    <div v-if="snapshot?.error || error || localError" class="notice notice-error" role="alert">
      {{ localError || snapshot?.error || error }}
    </div>
    <div v-if="externalSnapshot" class="notice notice-warning settings-conflict" role="alert">
      <span>{{ externalSnapshot.error || '设置文件已在外部修改。当前草稿仍保留，保存时会检查文件版本。' }}</span>
      <button v-if="!externalSnapshot.error" class="button button-secondary button-small" type="button" @click="onReloadExternal">重新加载外部版本</button>
    </div>

    <section class="settings-section">
      <label class="field-label" for="theme-choice">外观</label>
      <select id="theme-choice" :value="theme" @change="changeTheme(($event.target as HTMLSelectElement).value as 'system' | 'light' | 'dark')">
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </section>

    <section class="settings-section">
      <div class="section-title-row">
        <div>
          <h2>设置文件</h2>
          <p class="muted">UTF-8 JSON 文本，可放在同步目录中。</p>
        </div>
        <button class="button button-secondary" type="button" :disabled="dirty || (!!externalSnapshot && !externalSnapshot.error)" @click="onChoosePath">更改位置</button>
      </div>
      <code class="path-value">{{ snapshot?.path || '尚未读取设置文件路径' }}</code>
    </section>

    <section class="settings-section template-grid">
      <div>
        <div class="section-title-row">
          <div>
            <h2>设置 JSON</h2>
            <p class="muted">模板接受任意合法 JSON 值，字段绑定由文件中的 bindings 指定。</p>
          </div>
          <button class="button button-primary" type="button" :disabled="saving || !snapshot || !dirty" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button>
        </div>
        <textarea v-model="source" class="json-editor" spellcheck="false" aria-label="设置 JSON"></textarea>
      </div>
      <aside class="template-preview">
        <h2>新词条模板预览</h2>
        <pre>{{ preview }}</pre>
        <p class="muted">词典 provider：手动录入</p>
      </aside>
    </section>
  </section>
</template>
