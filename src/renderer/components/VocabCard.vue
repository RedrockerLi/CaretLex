<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { JsonValue, VocabRecord } from '../types'

const props = defineProps<{
  entry: VocabRecord
  x: number
  y: number
  busy?: boolean
}>()
const emit = defineEmits<{
  close: []
  stay: []
  leave: []
  edit: [value: JsonValue]
  delete: []
}>()

const editing = ref(false)
const confirmingDelete = ref(false)
const expanded = ref(false)
const json = ref('')
const error = ref('')

watch(() => props.entry.value, (value) => {
  json.value = JSON.stringify(value, null, 2)
  error.value = ''
}, { immediate: true, deep: true })

const position = computed(() => ({ left: `${Math.max(12, Math.min(props.x, window.innerWidth - 352))}px`, top: `${Math.max(12, Math.min(props.y, window.innerHeight - 420))}px` }))
const objectValue = computed(() => props.entry.value && typeof props.entry.value === 'object' && !Array.isArray(props.entry.value) ? props.entry.value as Record<string, JsonValue> : null)
const translation = computed(() => objectValue.value?.translation)
const example = computed(() => objectValue.value?.example)

function save() {
  try {
    emit('edit', JSON.parse(json.value) as JsonValue)
    editing.value = false
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'JSON 格式无效。'
  }
}
</script>

<template>
  <section class="vocab-card" :style="position" aria-label="词条详情" @mouseenter="emit('stay')" @mouseleave="emit('leave')">
    <header class="vocab-card-header">
      <div>
        <span class="eyebrow">{{ entry.managed ? '本篇文档词条' : '区块外词条 · 只读' }}</span>
        <h3>{{ entry.lemma }}</h3>
      </div>
      <button class="icon-button" type="button" aria-label="关闭词条卡" @click="emit('close')">×</button>
    </header>
    <p v-if="typeof translation === 'string' && translation" class="translation">{{ translation }}</p>
    <p v-else class="muted">此词条没有可识别的 translation 字段。</p>
    <p v-if="typeof example === 'string' && example" class="example">{{ example }}</p>
    <div v-if="expanded || editing" class="full-value">
      <label v-if="editing" class="field-label" for="entry-json-edit">完整 JSON</label>
      <textarea v-if="editing" id="entry-json-edit" v-model="json" class="json-editor compact" rows="8" spellcheck="false"></textarea>
      <pre v-else>{{ JSON.stringify(entry.value, null, 2) }}</pre>
      <p v-if="error" class="error-text">{{ error }}</p>
    </div>
    <div v-else class="card-links">
      <button class="text-button" type="button" @click="expanded = true">查看完整 JSON</button>
    </div>
    <footer class="vocab-card-actions">
      <template v-if="entry.managed">
        <template v-if="editing">
          <button class="button button-secondary" type="button" @click="editing = false">取消</button>
          <button class="button button-primary" type="button" :disabled="busy" @click="save">保存修改</button>
        </template>
        <template v-else-if="confirmingDelete">
          <span class="delete-prompt">移除全部正文引用？原文会保留。</span>
          <button class="button button-secondary" type="button" @click="confirmingDelete = false">取消</button>
          <button class="button button-danger" type="button" :disabled="busy" @click="emit('delete')">确认删除</button>
        </template>
        <template v-else>
          <button class="text-button" type="button" @click="editing = true; expanded = true">编辑</button>
          <button class="text-button danger-link" type="button" @click="confirmingDelete = true">删除</button>
        </template>
      </template>
    </footer>
  </section>
</template>
