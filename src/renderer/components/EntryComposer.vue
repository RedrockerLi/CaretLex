<script setup lang="ts">
import { computed } from 'vue'
import { EntrySession } from '../../shared/entry-session'
const props = defineProps<{ session: EntrySession; busy?: boolean }>()
const emit = defineEmits<{ cancel: []; submit: []; retry: [] }>()
const parsed = computed(() => props.session.parse())
</script>
<template>
  <section class="entry-composer" aria-labelledby="composer-title" @mousedown.stop>
    <header class="composer-header"><div><p class="eyebrow">{{ session.requestId ? '正在获取自动数据' : '未保存的词条草稿' }}</p><h2 id="composer-title">保存选词</h2></div><button class="icon-button" :disabled="session.saving" aria-label="关闭录入卡" @click="emit('cancel')">×</button></header>
    <div class="selected-context"><span class="context-label">原词</span><strong>{{ session.location.selected }}</strong></div>
    <p v-if="!session.article" class="field-hint">原句尚不可用；可手动整理完整 JSON。</p>
    <label class="field-label" for="lemma-input">词条原型（lemma）{{ session.locked ? ' · 身份已锁定' : ' · 待确认' }}</label>
    <input id="lemma-input" :value="session.lemma" :disabled="session.locked || session.saving" autocomplete="off" spellcheck="false" @input="session.setLemma(($event.target as HTMLInputElement).value)" />
    <p v-if="!session.locked" class="field-hint">初始小写词形只是建议，请确认词条原型；本地检查不验证语义。</p>
    <div v-if="session.error" class="notice notice-error" role="alert">{{ session.error }}</div>
    <details v-if="session.issues.length" class="notice notice-warning" open><summary>待处理诊断（{{ session.issues.length }}）</summary><ul><li v-for="(issue, index) in session.issues" :key="index">{{ issue.message }}</li></ul></details>
    <div v-if="session.pending" class="notice notice-info"><p>新结果可应用（目标 {{ session.pending.lemma }}），当前手改稿已保留。</p><details><summary>检查待应用 JSON</summary><pre>{{ JSON.stringify(session.pending.value, null, 2) }}</pre></details><button class="button button-secondary" :disabled="session.saving" @click="session.applyPending()">应用新结果并替换草稿</button></div>
    <label class="field-label" for="entry-json">完整词条 JSON</label>
    <textarea id="entry-json" :value="session.text" :disabled="session.saving" class="json-editor compact" rows="10" spellcheck="false" @input="session.edit(($event.target as HTMLTextAreaElement).value)"></textarea>
    <p v-if="!parsed.ok" class="error-text">{{ parsed.message }}</p>
    <details class="value-preview"><summary>本次候选和来源 JSON</summary><pre>{{ JSON.stringify({ candidate: session.candidate, sources: session.sources }, null, 2) }}</pre></details>
    <footer class="composer-actions"><button class="button button-secondary" :disabled="session.saving" @click="emit('cancel')">取消</button><button class="button button-secondary" :disabled="session.saving || session.invalid" @click="emit('retry')">手动重新获取</button><button class="button button-primary" :disabled="!parsed.ok || session.invalid || session.saving || busy" @click="emit('submit')">{{ session.saving ? '写入中…' : session.locked ? '保存锁定词条' : '确认并保存' }}</button></footer>
  </section>
</template>
