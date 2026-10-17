<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { SettingsSnapshot, ProviderDescription, DictionaryCacheStats } from '../../shared/bridge'
import { defaultSettings, parseSettings, renameProfile, type AppSettings } from '../../shared/settings'
import { defaultDictionaryPrompt, defaultDictionaryResponse, defaultPrompt, isDefaultSaveStructure, legacyDefaultPrompt, llmApiTypes } from '../../shared/providers'
import type { JsonValue } from '../../shared/types'
import merriamWebsterLight from '../assets/merriam-webster-light.png'
import merriamWebsterDark from '../assets/merriam-webster-dark.png'

const props = defineProps<{
  snapshot: SettingsSnapshot | null; externalSnapshot: SettingsSnapshot | null; draft: string; dirty: boolean; error: string
  onSave: (value: unknown) => Promise<boolean>; onReset: () => Promise<boolean>
  onChoosePath: () => Promise<void>; onReloadExternal: () => void
}>()
const emit = defineEmits<{ close: []; 'update:draft': [value: string]; 'credentials-dirty': [value: boolean] }>()
const source = ref(props.draft)
const localError = ref('')
const notice = ref('')
const saving = ref(false)
const descriptions = shallowRef<ProviderDescription[]>([])
const keys = shallowRef<Record<string, string>>(Object.create(null))
const credentialStates = shallowRef<Record<string, string>>(Object.create(null))
const credentialMasks = shallowRef<Record<string, string>>(Object.create(null))
const buffers = ref<Record<string, string>>({})
const bufferErrors = ref<Record<string, string>>({})
const expandedProviders = ref<number[]>([])
const dictionaryKey = ref('')
const dictionaryCredentialState = ref('正在检查本机凭据…')
const dictionaryCredentialMask = ref('')
const cacheStats = ref<DictionaryCacheStats | null>(null)
const cacheError = ref('')
const hasKeys = computed(() => Object.values(keys.value).some(Boolean) || !!dictionaryKey.value)
const hasLocalEdits = computed(() => hasKeys.value || !!Object.keys(bufferErrors.value).length)
const validation = computed(() => parseSettings(source.value))
watch(hasLocalEdits, value => emit('credentials-dirty', value))
watch(() => props.draft, draft => {
  if (source.value !== draft) { source.value = draft; buffers.value = {}; bufferErrors.value = {} }
}, { immediate: true })
watch(source, draft => emit('update:draft', draft))
const form = computed<AppSettings | undefined>(() => {
  try {
    const raw = JSON.parse(source.value)
    // Partial connection parameters remain editable even when validation fails.
    if (!(raw && ['system', 'light', 'dark'].includes(raw.theme) && Object.hasOwn(raw, 'saveTemplate')
      && !Object.hasOwn(raw, 'version') && Array.isArray(raw.providers)
      && raw.providers.every((item: unknown) => !!item && typeof item === 'object' && 'name' in item && typeof item.name === 'string'
        && 'type' in item && typeof item.type === 'string' && 'enabled' in item && typeof item.enabled === 'boolean' && 'config' in item))) return undefined
    if (raw.dictionary !== undefined && (!raw.dictionary || typeof raw.dictionary !== 'object' || Array.isArray(raw.dictionary))) return undefined
    return {
      ...raw,
      dictionary: {
        ...defaultSettings.dictionary,
        ...(raw.dictionary ?? {}),
        responseTemplate: raw.dictionary?.responseTemplate ?? defaultDictionaryResponse
      }
    }
  } catch { return undefined }
})
function keyValue(name: string) { return Object.hasOwn(keys.value, name) ? keys.value[name] : '' }
function setKey(name: string, value: string) { keys.value = { ...keys.value, [name]: value } }
function credentialState(name: string) { return Object.hasOwn(credentialStates.value, name) ? credentialStates.value[name] : '正在检查本机凭据…' }
function maskValue(name: string) { return Object.hasOwn(credentialMasks.value, name) ? credentialMasks.value[name] : '' }
function apiInfo(value: JsonValue | undefined) { return llmApiTypes.find(item => item.value === value) }
function editorValue(id: string, value: unknown) { return Object.hasOwn(buffers.value, id) ? buffers.value[id] : JSON.stringify(value, null, 2) ?? '' }
function update(operation: (settings: AppSettings) => void) {
  if (!form.value) { localError.value = '请修复设置文件，或恢复默认设置。'; return }
  const settings = JSON.parse(JSON.stringify(form.value)) as AppSettings
  operation(settings)
  source.value = JSON.stringify(settings, null, 2)
  localError.value = ''
}
function configField(index: number, key: string, value: JsonValue) {
  update(settings => {
    const config = settings.providers[index].config
    if (config && typeof config === 'object' && !Array.isArray(config)) config[key] = value
  })
}
function changeApi(index: number, value: string) {
  configField(index, 'apiType', value)
  if (!apiInfo(value)?.jsonMode) configField(index, 'jsonMode', false)
}
function jsonField(index: number, key: string, text: string) {
  const id = `${index}:${key}`
  buffers.value[id] = text
  try {
    const value = JSON.parse(text)
    if (key === 'config') update(settings => { settings.providers[index].config = value })
    else configField(index, key, value)
    delete bufferErrors.value[id]
  } catch { bufferErrors.value[id] = '请输入合法 JSON；当前输入保留，修正后才能保存。' }
}
function dictionaryField(key: 'enabled' | 'timeoutMs', value: JsonValue) {
  update(settings => { (settings.dictionary as unknown as Record<string, JsonValue>)[key] = value })
}
function dictionaryJsonField(text: string) {
  const id = 'dictionary:responseTemplate'
  buffers.value[id] = text
  try {
    const value = JSON.parse(text)
    update(settings => { settings.dictionary.responseTemplate = value })
    delete bufferErrors.value[id]
  } catch { bufferErrors.value[id] = '请输入合法 JSON；当前输入保留，修正后才能保存。' }
}
function restorePrompt(index: number) {
  configField(index, 'prompt', form.value?.dictionary.enabled ? defaultDictionaryPrompt : defaultPrompt)
}
function changeProviderType(index: number, type: string) {
  const description = descriptions.value.find(item => item.type === type)
  if (!description) return
  update(settings => {
    settings.providers[index].type = type
    const config = JSON.parse(JSON.stringify(description.defaultConfig)) as JsonValue
    if (type === 'LLM' && settings.dictionary.enabled && config && typeof config === 'object' && !Array.isArray(config)) {
      (config as Record<string, JsonValue>).prompt = defaultDictionaryPrompt
    }
    settings.providers[index].config = config
  })
  buffers.value = {}
  bufferErrors.value = {}
}
function toggleDictionary(enabled: boolean) {
  update(settings => {
    settings.dictionary.enabled = enabled
    if (enabled && !settings.dictionary.responseTemplate) settings.dictionary.responseTemplate = defaultDictionaryResponse
    for (const profile of settings.providers) {
      if (profile.type !== 'LLM' || !profile.config || typeof profile.config !== 'object' || Array.isArray(profile.config)) continue
      const config = profile.config as Record<string, JsonValue>
      if (enabled && (config.prompt === defaultPrompt || config.prompt === legacyDefaultPrompt)) config.prompt = defaultDictionaryPrompt
      if (!enabled && config.prompt === defaultDictionaryPrompt) config.prompt = defaultPrompt
    }
  })
  notice.value = enabled
    ? '词典增强已启用；已启用实例的 Prompt 需要包含 {{dictionary}}，保存时校验。'
    : '词典增强已停用；词典增强默认 Prompt 已恢复为普通默认。'
}
async function dictionaryCredential() {
  const ref = form.value?.dictionary.apiKeyRef
  try {
    const status = await window.caretlex.credentialStatus(typeof ref === 'string' ? ref : undefined)
    dictionaryCredentialMask.value = status.masked ?? ''
    dictionaryCredentialState.value = status.error ?? (status.exists ? '本机凭据可用' : ref ? '本机凭据缺失' : '无凭据引用')
  } catch { dictionaryCredentialState.value = '无法查询本机凭据' }
}
async function removeDictionaryKey() {
  const ref = form.value?.dictionary.apiKeyRef
  if (typeof ref !== 'string') return
  saving.value = true; localError.value = ''
  try {
    await window.caretlex.removeCredential(ref)
    dictionaryCredentialMask.value = ''
    update(settings => { delete settings.dictionary.apiKeyRef })
    notice.value = '词典 Key 已删除并从草稿移除引用；保存设置后生效。'
  } catch (error) { localError.value = error instanceof Error ? error.message : '词典 Key 删除失败。' }
  finally { saving.value = false }
}
async function refreshCacheStats() {
  cacheError.value = ''
  try { cacheStats.value = await window.caretlex.dictionaryCacheStats() }
  catch { cacheStats.value = null; cacheError.value = '无法读取词典缓存状态。' }
}
async function clearCache() {
  saving.value = true; cacheError.value = ''
  try { cacheStats.value = await window.caretlex.clearDictionaryCache(); notice.value = '词典缓存已清空。' }
  catch { cacheError.value = '词典缓存清空失败。' }
  finally { saving.value = false }
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
function openMerriamWebster() { void window.caretlex.openExternal('https://www.merriam-webster.com/') }
const dictionaryLogo = computed(() => {
  const theme = form.value?.theme ?? 'system'
  const dark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  return dark ? merriamWebsterDark : merriamWebsterLight
})
const promptVariablesHint = computed(() => form.value?.dictionary.enabled
  ? '变量：{{article.original_word}}、{{article.original_sentence}}、{{JSON}}（响应 JSON 示例）、{{dictionary}}（词典参考）；请求内容就是本模板替换变量后的结果，应用不追加任何隐藏内容。'
  : '变量：{{article.original_word}}、{{article.original_sentence}}、{{JSON}}（响应 JSON 示例）；请求内容就是本模板替换变量后的结果，应用不追加任何隐藏内容。')
function rename(index: number, name: string) {
  if (!form.value) return
  const oldName = form.value.providers[index].name
  source.value = JSON.stringify(renameProfile(form.value, oldName, name), null, 2)
  if (oldName !== name && keyValue(oldName)) {
    const nextKeys = { ...keys.value, [name]: keyValue(oldName) }
    delete nextKeys[oldName]; keys.value = nextKeys
  }
}
async function toggle(index: number, enabled: boolean) {
  if (!form.value) return
  const before = source.value
  const settings = JSON.parse(JSON.stringify(form.value)) as AppSettings
  const profile = settings.providers[index]
  if (enabled) {
    settings.providers.forEach(item => { item.enabled = false }); profile.enabled = true
    const preset = await window.caretlex.providerPreset({ type: profile.type, name: profile.name, config: profile.config })
      .catch(error => ({ template: null, reason: String(error) }))
    if (source.value !== before) { notice.value = '草稿在预设获取期间变化，请再次启用。'; return }
    if (!isDefaultSaveStructure(settings.saveTemplate)) notice.value = '预设未应用：保存结构已自定义，请在设置文件中维护映射，或手动填写词条。'
    else if (preset.template === null) notice.value = `预设未完整应用：${preset.reason}`
    else { settings.saveTemplate = preset.template; notice.value = `已生成 ${profile.name} 的完整保存预设，保存设置后生效。` }
  } else { profile.enabled = false; notice.value = '实例已在草稿中停用，保存模板保留。' }
  source.value = JSON.stringify(settings, null, 2)
}
function add(type: string) {
  const description = descriptions.value.find(item => item.type === type)
  if (!description || !form.value) return
  const index = form.value.providers.length
  update(settings => {
    const prefix = type.toLowerCase()
    let number = 1
    while (settings.providers.some(item => item.name === `${prefix}_${number}`)) number++
    const config = JSON.parse(JSON.stringify(description.defaultConfig)) as JsonValue
    if (type === 'LLM' && settings.dictionary.enabled && config && typeof config === 'object' && !Array.isArray(config)) {
      (config as Record<string, JsonValue>).prompt = defaultDictionaryPrompt
    }
    settings.providers.push({ name: `${prefix}_${number}`, type, enabled: false, config })
  })
  expandedProviders.value.push(index)
}
function toggleExpanded(index: number) {
  expandedProviders.value = expandedProviders.value.includes(index)
    ? expandedProviders.value.filter(item => item !== index)
    : [...expandedProviders.value, index]
}
function remove(index: number) {
  const name = form.value?.providers[index].name
  if (name !== undefined) { const next = { ...keys.value }; delete next[name]; keys.value = next }
  buffers.value = {}; bufferErrors.value = {}
  update(settings => { settings.providers.splice(index, 1) })
  expandedProviders.value = expandedProviders.value.filter(item => item !== index).map(item => item > index ? item - 1 : item)
}
async function credential(ref: string | undefined, name: string) {
  try {
    const status = await window.caretlex.credentialStatus(ref)
    credentialMasks.value = { ...credentialMasks.value, [name]: status.masked ?? '' }
    credentialStates.value = { ...credentialStates.value, [name]: status.error ?? (status.exists ? '本机凭据可用' : ref ? '本机凭据缺失' : '无凭据引用，使用匿名请求') }
  } catch { credentialStates.value = { ...credentialStates.value, [name]: '无法查询本机凭据' } }
}
async function removeKey(index: number) {
  const profile = form.value?.providers[index]
  const config = profile?.config
  const ref = config && typeof config === 'object' && !Array.isArray(config) ? config.apiKeyRef : undefined
  if (!profile || typeof ref !== 'string') return
  saving.value = true; localError.value = ''
  try {
    await window.caretlex.removeCredential(ref)
    credentialMasks.value = { ...credentialMasks.value, [profile.name]: '' }
    update(settings => { delete (settings.providers[index].config as Record<string, JsonValue>).apiKeyRef })
    notice.value = '本机 Key 已删除并从草稿移除引用；保存设置后生效。'
  } catch (error) { localError.value = error instanceof Error ? error.message : '本机 Key 删除失败。' }
  finally { saving.value = false }
}
watch(() => form.value?.providers.map(profile => ({ name: profile.name, ref: profile.config && typeof profile.config === 'object' && !Array.isArray(profile.config) ? profile.config.apiKeyRef : undefined })), profiles => {
  for (const profile of profiles ?? []) void credential(typeof profile.ref === 'string' ? profile.ref : undefined, profile.name)
}, { immediate: true, deep: true })
watch(() => form.value?.dictionary.apiKeyRef, () => { void dictionaryCredential() }, { immediate: true })
onMounted(async () => {
  try { descriptions.value = await window.caretlex.providerTypes() } catch (error) { localError.value = String(error) }
  void refreshCacheStats()
})
async function restoreDefaults() {
  saving.value = true; localError.value = ''; notice.value = ''
  try {
    if (await props.onReset()) {
      keys.value = Object.create(null); credentialMasks.value = Object.create(null); buffers.value = {}; bufferErrors.value = {}
      dictionaryKey.value = ''; dictionaryCredentialMask.value = ''; dictionaryCredentialState.value = '正在检查本机凭据…'
      void refreshCacheStats()
      notice.value = '已恢复并保存默认设置。'
    } else localError.value = props.error || '默认设置未恢复。'
  } catch (error) { localError.value = error instanceof Error ? error.message : String(error) }
  finally { saving.value = false }
}
async function save() {
  localError.value = ''
  if (Object.keys(bufferErrors.value).length) { localError.value = Object.values(bufferErrors.value).join(' '); return }
  const checked = parseSettings(source.value)
  if (!checked.ok) { localError.value = checked.error.message; return }
  saving.value = true
  try {
    const settings = checked.value
    if (dictionaryKey.value) {
      const ref = await window.caretlex.saveCredential(dictionaryKey.value)
      settings.dictionary.apiKeyRef = ref
      dictionaryKey.value = ''
    }
    for (const profile of settings.providers) {
      if (keyValue(profile.name)) {
        const ref = await window.caretlex.saveCredential(keyValue(profile.name))
        ;(profile.config as Record<string, JsonValue>).apiKeyRef = ref
        setKey(profile.name, '')
      }
    }
    source.value = JSON.stringify(settings, null, 2)
    if (!(await props.onSave(settings))) localError.value = props.error || '设置未保存；旧运行配置和凭据引用仍有效。'
    else { notice.value = '设置已保存。'; void refreshCacheStats() }
  } catch (error) { localError.value = error instanceof Error ? error.message : String(error) }
  finally { saving.value = false }
}
</script>
<template>
  <section class="settings-page" aria-labelledby="settings-title">
    <header class="settings-heading">
      <div><h1 id="settings-title">设置 <small v-if="dirty || hasLocalEdits" class="settings-dirty-label">未保存</small></h1><p class="settings-heading-description">管理应用外观与 Provider。</p></div>
      <div class="settings-heading-actions"><button class="icon-button" aria-label="关闭设置" :disabled="saving" @click="emit('close')">×</button></div>
    </header>
    <div v-if="localError || snapshot?.error || error" class="notice notice-error" role="alert">{{ localError || snapshot?.error || error }}</div>
    <div v-if="notice && notice !== '设置已保存。'" class="notice notice-info" role="status">{{ notice }}</div>
    <div v-if="externalSnapshot" class="notice notice-warning settings-conflict"><span>设置文件已变化，草稿保留。</span><button class="button button-secondary" :disabled="saving" @click="onReloadExternal">重新加载外部版本</button></div>
    <section class="settings-section settings-panel settings-general" aria-labelledby="settings-general-title">
      <header class="settings-panel-heading"><h2 id="settings-general-title">通用设置</h2><p class="muted">管理应用外观与配置文件位置。</p></header>
      <div v-if="form" class="settings-row settings-theme">
        <div class="settings-row-copy"><label class="settings-row-label" for="settings-theme">外观</label><p class="muted">选择浅色、深色或跟随系统。</p></div>
        <select id="settings-theme" :value="form.theme" :disabled="saving" @change="update(settings => { settings.theme = ($event.target as HTMLSelectElement).value as AppSettings['theme'] })"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select>
      </div>
      <div v-if="form" class="settings-row settings-quick-add">
        <div class="settings-row-copy"><label class="settings-row-label" for="settings-quick-add">划词后直接保存</label><p class="muted">开启后“存为词条”在后台获取并写入词条，不打开录入窗；获取失败或超时时写入空释义条目，可在悬停卡补全。</p></div>
        <input id="settings-quick-add" type="checkbox" :checked="form.quickAdd === true" :disabled="saving" @change="update(settings => { settings.quickAdd = ($event.target as HTMLInputElement).checked })" />
      </div>
      <div class="settings-row settings-file">
        <div class="settings-row-copy"><span class="settings-row-label">设置文件</span><code class="path-value">{{ snapshot?.path || '正在读取设置文件…' }}</code></div>
        <button class="button button-secondary" :disabled="saving || (dirty && !!snapshot?.value)" @click="onChoosePath">更改位置</button>
      </div>
    </section>
    <p v-if="!form" class="settings-recovery muted">当前配置无法用于表单。可修复上方路径的设置文件，或点击“恢复默认设置”写入默认配置。</p>
    <template v-if="form">
      <section class="settings-section settings-panel settings-dictionary" aria-labelledby="settings-dictionary-title">
        <header class="settings-panel-heading">
          <h2 id="settings-dictionary-title">词典增强</h2>
          <p class="muted">使用 Merriam-Webster Learner's Dictionary 提供 lemma 和英文释义；LLM 从候选中选择义项，填写中文释义与例句。</p>
        </header>
        <div class="settings-row settings-dictionary-enabled">
          <div class="settings-row-copy">
            <label class="settings-row-label" for="settings-dictionary-enabled">启用词典增强</label>
            <p class="muted">词典参考会随 Prompt 发送给已启用的 LLM 服务。词典失败、超时或无词条时回退纯 LLM，并在录入窗诊断区提示。</p>
          </div>
          <input id="settings-dictionary-enabled" data-field="dictionary-enabled" type="checkbox" :checked="form.dictionary.enabled === true" :disabled="saving" @change="toggleDictionary(($event.target as HTMLInputElement).checked)" />
        </div>
        <div class="settings-row">
          <div class="settings-row-copy">
            <span class="settings-row-label">Learner's API Key</span>
            <div v-if="form.dictionary.apiKeyRef" class="key-row">
              <span class="key-name">dictionary</span>
              <code v-if="dictionaryCredentialMask" class="key-mask">{{ dictionaryCredentialMask }}</code>
              <span v-else class="key-missing">本机凭据缺失</span>
              <button type="button" class="text-button danger-link" :disabled="saving" @click="removeDictionaryKey">删除</button>
            </div>
            <label>
              <span class="field-label">API Key</span>
              <input data-field="dictionary-key" :value="dictionaryKey" type="password" autocomplete="new-password" placeholder="输入新 Key 以替换；留空保留现有引用" @input="dictionaryKey = ($event.target as HTMLInputElement).value" />
            </label>
            <p class="field-hint">{{ dictionaryCredentialState }}。Key 存在本机独立明文文件中，权限为 0600。</p>
          </div>
        </div>
        <div class="settings-row settings-dictionary-timeout">
          <div class="settings-row-copy">
            <label class="settings-row-label" for="settings-dictionary-timeout">词典超时（毫秒）</label>
          </div>
          <input id="settings-dictionary-timeout" data-field="dictionary-timeout" type="number" min="1" max="2147483647" :value="form.dictionary.timeoutMs" :disabled="saving" @input="dictionaryField('timeoutMs', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="settings-editors">
          <label>
            <span class="field-label">词典增强响应 JSON 示例</span>
            <textarea data-field="dictionary-responseTemplate" :value="editorValue('dictionary:responseTemplate', form.dictionary.responseTemplate)" class="json-editor response-editor" spellcheck="false" @input="dictionaryJsonField(($event.target as HTMLTextAreaElement).value)"></textarea>
            <span v-if="bufferErrors['dictionary:responseTemplate']" class="error-text">{{ bufferErrors['dictionary:responseTemplate'] }}</span>
            <span class="field-hint">实际发给 LLM 的精简 JSON；包含 lemma、context_sense_id、中文释义、例句和兜底英文释义。</span>
          </label>
        </div>
        <div class="settings-row">
          <div class="settings-row-copy">
            <span class="settings-row-label">本地词典缓存</span>
            <p class="muted">{{ cacheStats ? `${cacheStats.entries} 条 / ${formatBytes(cacheStats.bytes)}` : cacheError || '正在读取缓存状态…' }}</p>
          </div>
          <button class="button button-secondary" data-field="dictionary-clear-cache" :disabled="saving || !cacheStats?.available" @click="clearCache">清空缓存</button>
        </div>
        <div class="settings-row dictionary-attribution">
          <div class="settings-row-copy">
            <span class="settings-row-label">Merriam-Webster</span>
            <p class="muted">Dictionary data from Merriam-Webster Learner's Dictionary.</p>
          </div>
          <button type="button" class="dictionary-logo-button" aria-label="打开 Merriam-Webster 官网" @click="openMerriamWebster">
            <img :src="dictionaryLogo" alt="Merriam-Webster" width="50" height="50" />
          </button>
        </div>
      </section>
      <section class="settings-section settings-panel">
        <div class="section-title-row"><div><h2>Provider 实例</h2><p class="muted">一次最多启用一个实例。修改后保存设置才会生效。</p></div><div><button v-for="description in descriptions" :key="description.type" class="button button-secondary" :disabled="saving" @click="add(description.type)">添加 provider{{ descriptions.length > 1 ? ` · ${description.type}` : '' }}</button></div></div>
        <p v-if="!form.providers.length" class="settings-empty muted">尚未添加实例。可以直接手动录入词条，或添加 provider 自动填写。</p>
        <section v-for="(profile, index) in form.providers" :key="index" class="provider-form">
          <header class="provider-header">
            <h3 class="provider-title"><button class="provider-expand" type="button" :aria-expanded="expandedProviders.includes(index)" :aria-controls="`settings-provider-${index}`" @click="toggleExpanded(index)"><span class="provider-chevron" :class="{ expanded: expandedProviders.includes(index) }" aria-hidden="true">›</span><span class="provider-name">{{ profile.name || '未命名实例' }}</span><span class="provider-badge">{{ profile.type }}</span></button></h3>
            <div class="provider-actions"><button data-field="enabled" type="button" class="button" :class="profile.enabled ? 'provider-enabled' : 'button-secondary'" :aria-pressed="profile.enabled" :aria-label="`${profile.enabled ? '停用' : '启用'} ${profile.name || '未命名实例'}`" :title="profile.enabled ? '停用实例，保留保存模板' : '启用实例并应用可用预设'" :disabled="saving" @click="toggle(index, !profile.enabled)">{{ profile.enabled ? '已启用 · 停用' : '启用' }}</button><button type="button" class="button provider-delete" :aria-label="`删除 ${profile.name || '未命名实例'}`" :disabled="saving" @click="remove(index)">删除</button></div>
          </header>
          <fieldset v-show="expandedProviders.includes(index)" :id="`settings-provider-${index}`" class="provider-fields" :aria-label="`${profile.name || '未命名实例'} 配置`" :disabled="saving">
          <div class="settings-field-grid">
            <label><span class="field-label">实例名称</span><input data-field="name" :value="profile.name" @change="rename(index, ($event.target as HTMLInputElement).value)" /><span class="field-hint">保存映射通过此名称引用来源。</span></label>
            <label><span class="field-label">Provider 类型</span><select data-field="type" :value="profile.type" @change="changeProviderType(index, ($event.target as HTMLSelectElement).value)"><option v-for="description in descriptions" :key="description.type" :value="description.type">{{ description.type }}</option></select></label>
            <template v-if="profile.type === 'LLM' && profile.config && typeof profile.config === 'object' && !Array.isArray(profile.config)">
              <label><span class="field-label">API 类型</span><select data-field="apiType" :value="profile.config.apiType" @change="changeApi(index, ($event.target as HTMLSelectElement).value)"><option v-for="api in llmApiTypes" :key="api.value" :value="api.value">{{ api.label }}</option></select></label>
              <label><span class="field-label">模型</span><input data-field="model" :value="profile.config.model" placeholder="服务提供的模型名称" @input="configField(index, 'model', ($event.target as HTMLInputElement).value)" /></label>
              <label class="field-wide"><span class="field-label">Base URL</span><input data-field="baseUrl" :value="profile.config.baseUrl" :placeholder="apiInfo(profile.config.apiType)?.placeholder" @input="configField(index, 'baseUrl', ($event.target as HTMLInputElement).value)" /><span class="field-hint">保留基础路径，追加 {{ apiInfo(profile.config.apiType)?.endpoint ?? '所选 API 的端点' }}。请自行填写 /v1 等版本路径。</span></label>
              <div class="field-wide"><div v-if="profile.config.apiKeyRef" class="key-row"><span class="key-name">{{ profile.name }}</span><code v-if="maskValue(profile.name)" class="key-mask">{{ maskValue(profile.name) }}</code><span v-else class="key-missing">本机凭据缺失</span><button type="button" class="text-button danger-link" :disabled="saving" @click="removeKey(index)">删除</button></div><label><span class="field-label">API Key</span><input data-field="key" :value="keyValue(profile.name)" type="password" autocomplete="new-password" placeholder="输入新 Key 以替换；留空保留现有引用" @input="setKey(profile.name, ($event.target as HTMLInputElement).value)" /></label><p class="field-hint">{{ credentialState(profile.name) }}。Key 存在本机独立明文文件中，权限为 0600。</p></div>
              <div class="settings-editors field-wide">
                <label><span class="field-label">Prompt <button type="button" class="text-button" :disabled="saving" @click="restorePrompt(index)">恢复默认 Prompt</button></span><textarea data-field="prompt" :value="String(profile.config.prompt ?? '')" class="prompt-editor" spellcheck="false" @input="configField(index, 'prompt', ($event.target as HTMLTextAreaElement).value)"></textarea><span class="field-hint">{{ promptVariablesHint }}</span></label>
                <label><span class="field-label">响应 JSON 示例（保存映射使用）</span><textarea data-field="responseTemplate" :value="editorValue(`${index}:responseTemplate`, profile.config.responseTemplate)" class="json-editor response-editor" spellcheck="false" @input="jsonField(index, 'responseTemplate', ($event.target as HTMLTextAreaElement).value)"></textarea><span v-if="bufferErrors[`${index}:responseTemplate`]" class="error-text">{{ bufferErrors[`${index}:responseTemplate`] }}</span><span class="field-hint">声明保存映射使用的字段与类型；词典增强启用时，实际发给 LLM 的响应示例在“词典增强”设置中。</span></label>
              </div>
              <div class="settings-request-options field-wide">
                <div><label class="checkbox-label"><input data-field="jsonMode" type="checkbox" :disabled="!apiInfo(profile.config.apiType)?.jsonMode" :checked="profile.config.jsonMode === true" @change="configField(index, 'jsonMode', ($event.target as HTMLInputElement).checked)" />JSON mode</label><p class="field-hint">{{ apiInfo(profile.config.apiType)?.jsonMode ? '服务需支持所选 API 的 JSON 输出模式。' : '此 API 使用 Prompt 请求 JSON，并在本地严格解析。' }}</p></div>
                <label><span class="field-label">超时（毫秒）</span><input data-field="timeoutMs" type="number" min="1" max="2147483647" :value="profile.config.timeoutMs" @input="configField(index, 'timeoutMs', Number(($event.target as HTMLInputElement).value))" /></label>
                <label><span class="field-label">最大输出 tokens</span><input data-field="maxOutputTokens" type="number" min="1" max="2147483647" :value="profile.config.maxOutputTokens" @input="configField(index, 'maxOutputTokens', Number(($event.target as HTMLInputElement).value))" /></label>
              </div>
            </template>
            <label v-else class="field-wide"><span class="field-label">配置 JSON</span><textarea :value="editorValue(`${index}:config`, profile.config)" class="json-editor" spellcheck="false" @input="jsonField(index, 'config', ($event.target as HTMLTextAreaElement).value)"></textarea><span v-if="bufferErrors[`${index}:config`]" class="error-text">{{ bufferErrors[`${index}:config`] }}</span></label>
          </div>
          </fieldset>
        </section>
      </section>
    </template>
    <footer class="settings-actions"><button class="button button-secondary" :disabled="saving || !(externalSnapshot ?? snapshot)?.resetToken" @click="restoreDefaults">恢复默认设置</button><p role="status" :class="validation.ok && !Object.keys(bufferErrors).length ? 'muted' : 'error-text'">{{ Object.values(bufferErrors)[0] || (!validation.ok ? validation.error.message : dirty || hasLocalEdits ? '有未保存的修改' : '设置已保存') }}</p><button class="button button-primary" :disabled="saving || !snapshot?.revision || (!dirty && !hasKeys) || !validation.ok || !!Object.keys(bufferErrors).length" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button></footer>
  </section>
</template>
