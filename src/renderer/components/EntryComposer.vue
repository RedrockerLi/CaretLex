<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { JsonValue, VocabRecord } from '../types'
import { instantiateTemplate } from '../../shared/settings'
import type { AppSettings } from '../../shared/settings'

const props = defineProps<{
  selected: string
  sentence: string
  records: Map<string, VocabRecord>
  settings: AppSettings
  template: JsonValue
  defaultBindings: boolean
  busy?: boolean
}>()
const emit = defineEmits<{
  cancel: []
  submit: [entry: { lemma: string; value: JsonValue }]
}>()

const lemma = ref(props.selected.toLowerCase())
const translation = ref('')
const example = ref(props.sentence)
const customJson = ref('')
const jsonError = ref('')
const customJsonEdited = ref(false)
const manualInputs = ref<Record<string, JsonValue>>({})

const manualBindings = computed(() => Object.entries(props.settings.bindings)
  .filter(([, binding]) => binding.from === 'manual')
  .map(([pointer, binding]) => ({
    pointer,
    label: binding.from === 'manual' ? binding.label ?? pointer : pointer,
    required: binding.from === 'manual' && binding.required === true,
  })))

const templateResult = computed(() => instantiateTemplate(props.settings, {
  selected: props.selected,
  lemma: lemma.value,
  sentence: example.value,
}, manualInputs.value))

const parsedCustomValue = computed<{ ok: true; value: JsonValue } | { ok: false; message: string }>(() => {
  try {
    return { ok: true, value: JSON.parse(customJson.value) as JsonValue }
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : 'JSON 格式无效。' }
  }
})

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function setPointer(root: JsonValue, pointer: string, value: JsonValue): JsonValue {
  if (pointer === '') return value
  if (!pointer.startsWith('/')) return root
  const parts = pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  let current: unknown = root
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!current || typeof current !== 'object' || !(parts[index] in current)) return root
    current = (current as Record<string, unknown>)[parts[index]]
  }
  const last = parts[parts.length - 1]
  if (last && current && typeof current === 'object' && last in current) {
    ;(current as Record<string, unknown>)[last] = value
  }
  return root
}

const selectedRecord = computed(() => /^[a-z]+(?:['-][a-z]+)*$/.test(lemma.value) ? props.records.get(lemma.value) : undefined)
const currentRecord = computed(() => selectedRecord.value?.managed ? selectedRecord.value : undefined)
const readOnlyRecord = computed(() => selectedRecord.value && !selectedRecord.value.managed ? selectedRecord.value : undefined)
const validLemma = computed(() => /^[a-z]+(?:['-][a-z]+)*$/.test(lemma.value))
const previewValue = computed<JsonValue | null>(() => {
  if (currentRecord.value) return currentRecord.value.value
  if (props.defaultBindings) {
    let result = cloneJson(props.template)
    result = setPointer(result, '/word', lemma.value)
    result = setPointer(result, '/translation', translation.value)
    result = setPointer(result, '/example', example.value)
    return result
  }
  return parsedCustomValue.value.ok ? parsedCustomValue.value.value : null
})
const canSubmit = computed(() => {
  if (!validLemma.value || props.busy || readOnlyRecord.value) return false
  if (currentRecord.value) return true
  if (props.defaultBindings) return translation.value.trim().length > 0
  return templateResult.value.ok && parsedCustomValue.value.ok
})

watch(templateResult, (result) => {
  if (props.defaultBindings || customJsonEdited.value || !result.ok) return
  customJson.value = JSON.stringify(result.value, null, 2)
  jsonError.value = ''
}, { immediate: true })
watch(() => props.settings, () => {
  manualInputs.value = {}
  customJsonEdited.value = false
}, { deep: true })
watch(() => props.template, (template) => {
  if (props.defaultBindings || customJsonEdited.value) return
  customJson.value = JSON.stringify(template, null, 2)
}, { immediate: true })
watch(() => props.selected, (selected) => {
  lemma.value = selected.toLowerCase()
})
watch(() => props.sentence, (sentence) => {
  example.value = sentence
})

function manualText(pointer: string) {
  const value = manualInputs.value[pointer]
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
}

function updateManual(pointer: string, event: Event) {
  manualInputs.value[pointer] = (event.target as HTMLTextAreaElement).value
}

function submit() {
  jsonError.value = ''
  if (!canSubmit.value) return
  let value: JsonValue
  if (currentRecord.value) {
    value = currentRecord.value.value
  } else if (props.defaultBindings) {
    value = previewValue.value as JsonValue
  } else {
    if (!templateResult.value.ok) {
      jsonError.value = templateResult.value.error.message
      return
    }
    if (!parsedCustomValue.value.ok) {
      jsonError.value = parsedCustomValue.value.message
      return
    }
    value = parsedCustomValue.value.value
  }
  emit('submit', { lemma: lemma.value, value })
}
</script>

<template>
  <section class="entry-composer" aria-labelledby="composer-title" @mousedown.stop>
    <header class="composer-header">
      <div>
        <p class="eyebrow">手动词条</p>
        <h2 id="composer-title">保存选词</h2>
      </div>
      <button class="icon-button" type="button" aria-label="关闭录入卡" @click="emit('cancel')">×</button>
    </header>
    <div class="selected-context">
      <span class="context-label">原文</span>
      <span class="context-word">{{ selected }}</span>
    </div>
    <label class="field-label" for="lemma-input">词条原型（lemma）</label>
    <input id="lemma-input" v-model="lemma" autocomplete="off" spellcheck="false" />
    <p v-if="!validLemma" class="field-hint error-text">使用小写英文字母，可包含内部撇号或连字符。</p>

    <div v-if="currentRecord" class="notice notice-info">
      文档中已有 <strong>{{ lemma }}</strong>，本次只添加引用并复用原定义。
    </div>
    <div v-if="readOnlyRecord" class="notice notice-warning">
      词条 <strong>{{ lemma }}</strong> 的定义位于托管区块外，不能被应用接管。请改用新 lemma，或先在源码中处理该定义。
    </div>
    <template v-else-if="defaultBindings">
      <label class="field-label" for="translation-input">中文翻译 <span class="required">必填</span></label>
      <textarea id="translation-input" v-model="translation" rows="2" placeholder="输入中文释义"></textarea>
      <label class="field-label" for="example-input">英文例句 <span class="optional">可编辑</span></label>
      <textarea id="example-input" v-model="example" rows="3" placeholder="当前句子"></textarea>
      <details class="value-preview">
        <summary>保存内容预览</summary>
        <pre>{{ JSON.stringify(previewValue, null, 2) }}</pre>
      </details>
    </template>
    <template v-else-if="!currentRecord">
      <template v-for="field in manualBindings" :key="field.pointer">
        <label class="field-label" :for="`manual-${field.pointer}`">{{ field.label }} <span v-if="field.required" class="required">必填</span></label>
        <textarea :id="`manual-${field.pointer}`" :value="manualText(field.pointer)" rows="2" @input="updateManual(field.pointer, $event)"></textarea>
      </template>
      <template v-if="Object.values(settings.bindings).some((binding) => binding.from === 'sentence')">
        <label class="field-label" for="custom-example-input">当前句子 <span class="optional">可编辑</span></label>
        <textarea id="custom-example-input" v-model="example" rows="3"></textarea>
      </template>
      <label class="field-label" for="custom-json">词条 JSON</label>
      <textarea id="custom-json" v-model="customJson" class="json-editor compact" rows="7" spellcheck="false" @input="customJsonEdited = true"></textarea>
      <p v-if="jsonError || !templateResult.ok" class="field-hint error-text">{{ jsonError || (!templateResult.ok ? templateResult.error.message : '') }}</p>
      <details class="value-preview">
        <summary>保存内容预览</summary>
        <pre>{{ previewValue === null ? 'JSON 尚未通过解析' : JSON.stringify(previewValue, null, 2) }}</pre>
      </details>
    </template>

    <footer class="composer-actions">
      <button class="button button-secondary" type="button" @click="emit('cancel')">取消</button>
      <button class="button button-primary" type="button" :disabled="!canSubmit" @click="submit">{{ currentRecord ? '添加引用' : '存为词条' }}</button>
    </footer>
  </section>
</template>
