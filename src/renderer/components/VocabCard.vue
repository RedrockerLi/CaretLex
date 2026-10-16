<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { JsonValue, VocabRecord } from '../types'
import type { SaveResult } from '../../shared/bridge'
import { locateContext, validateIdentity } from '../../shared/entries'
import { isJsonValue } from '../../shared/json'
const props = defineProps<{
  entry: VocabRecord; x: number; y: number; busy?: boolean; sentence?: string; articleError?: string
  documentId: string; revision?: string
  onSave: (documentId: string, revision: string | undefined, lemma: string, value: JsonValue) => Promise<SaveResult>
}>()
const emit = defineEmits<{ close: []; stay: []; leave: []; delete: []; editing: [value: boolean] }>()
const editing = ref(false); const confirmingDelete = ref(false); const expanded = ref(false)
const json = ref(''); const error = ref(''); const saving = ref(false)
let baseRevision: string | undefined
let editingLemma = ''
let editingDocument = ''
watch(() => props.entry.value, value => {
  if (editing.value) { if (props.revision !== baseRevision && !saving.value) error.value = '文档版本已变化；手改稿保留，旧版本不能提交。'; return }
  json.value = JSON.stringify(value, null, 2); error.value = ''
}, { immediate: true, deep: true })
watch(() => props.revision, revision => { if (editing.value && revision !== baseRevision && !saving.value) error.value = '文档已变化；编辑稿保留，保存会检查开始编辑时的版本。' })
watch(editing, value => emit('editing', value))
const position = computed(() => ({ left: `${Math.max(12, Math.min(props.x, window.innerWidth - 440))}px`, top: `${Math.max(12, Math.min(props.y, window.innerHeight - 600))}px` }))
const context = computed(() => locateContext(props.entry.value, props.sentence))
function beginEdit() {
  editing.value = true; expanded.value = true
  baseRevision = props.revision; editingLemma = props.entry.lemma; editingDocument = props.documentId
  json.value = JSON.stringify(props.entry.value, null, 2); error.value = ''
}
async function save() {
  if (saving.value) return
  try {
    const value: unknown = JSON.parse(json.value)
    if (!isJsonValue(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024) throw new Error('JSON 必须是有限值且不超过 1 MiB。')
    const identity = validateIdentity(value, editingLemma, props.entry.value)
    if (!identity.ok) throw new Error(identity.error.message)
    saving.value = true
    await props.onSave(editingDocument, baseRevision, editingLemma, value)
    editing.value = false; error.value = ''
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '写入失败，编辑稿保留。' }
  finally { saving.value = false }
}
</script>
<template>
  <section class="vocab-card" :style="position" aria-label="词条详情" @mouseenter="emit('stay')" @mouseleave="emit('leave')">
    <header class="vocab-card-header"><div><span class="eyebrow">{{ entry.managed ? '本篇文档词条' : '区块外词条 · 只读' }}</span><h3>{{ entry.lemma }}</h3></div><button class="icon-button" :disabled="saving" aria-label="关闭词条卡" @click="emit('close')">×</button></header>
    <p v-if="context.context" class="translation" :class="{ placeholder: !context.context.meaning_in_context }">{{ context.context.meaning_in_context || '尚无中文释义，可点击“编辑”补全。' }}</p>
    <p v-else class="notice notice-warning">{{ articleError || context.message }}</p>
    <details v-if="!editing"><summary>全部上下文与其他词义</summary><pre>{{ JSON.stringify(entry.value, null, 2) }}</pre></details>
    <div v-if="expanded || editing" class="full-value"><label v-if="editing" class="field-label" for="entry-json-edit">完整 JSON · lemma 已锁定{{ editing ? ' · 未保存' : '' }}</label><textarea v-if="editing" id="entry-json-edit" v-model="json" :disabled="saving" class="json-editor compact" rows="12" spellcheck="false"></textarea><pre v-else>{{ JSON.stringify(entry.value, null, 2) }}</pre></div>
    <div v-else class="card-links"><button class="text-button" @click="expanded = true">查看完整 JSON</button></div><p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <footer class="vocab-card-actions"><template v-if="entry.managed"><template v-if="editing"><button class="button button-secondary" :disabled="saving" @click="editing = false">取消</button><button class="button button-primary" :disabled="busy || saving" @click="save">{{ saving ? '写入中…' : '保存修改' }}</button></template><template v-else-if="confirmingDelete"><span class="delete-prompt">移除全部正文引用？原文会保留。</span><button class="button button-secondary" @click="confirmingDelete = false">取消</button><button class="button button-danger" :disabled="busy" @click="emit('delete')">确认删除</button></template><template v-else><button class="text-button" @click="beginEdit">编辑</button><button class="text-button danger-link" @click="confirmingDelete = true">删除</button></template></template></footer>
  </section>
</template>
