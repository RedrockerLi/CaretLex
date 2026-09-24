<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import c from '@shikijs/langs/c'
import css from '@shikijs/langs/css'
import diff from '@shikijs/langs/diff'
import go from '@shikijs/langs/go'
import html from '@shikijs/langs/html'
import java from '@shikijs/langs/java'
import javascript from '@shikijs/langs/javascript'
import json from '@shikijs/langs/json'
import githubDark from '@shikijs/themes/github-dark'
import githubLight from '@shikijs/themes/github-light'

const props = defineProps<{ code: string; language: string; dark: boolean }>()

interface Token { content: string; color?: string; fontStyle: number }
type HighlightedLine = Token[]

const lines = ref<HighlightedLine[] | null>(null)
const failed = ref(false)
const themeName = computed(() => props.dark ? 'github-dark' : 'github-light')
const knownLanguages = [
  'c', 'css', 'diff', 'go', 'html', 'java', 'javascript', 'json', 'text',
] as const
type KnownLanguage = typeof knownLanguages[number]

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null
function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [githubDark, githubLight],
    langs: [c, css, diff, go, html, java, javascript, json],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  })
  return highlighterPromise
}

function normalizedLanguage(language: string): KnownLanguage {
  const alias: Record<string, KnownLanguage> = { js: 'javascript', jsx: 'javascript', txt: 'text', plain: 'text' }
  const value = alias[language.toLowerCase()] ?? language.toLowerCase()
  return knownLanguages.includes(value as KnownLanguage) ? value as KnownLanguage : 'text'
}

async function highlight() {
  failed.value = false
  try {
    const highlighter = await getHighlighter()
    const result = highlighter.codeToTokens(props.code, {
      lang: normalizedLanguage(props.language),
      theme: themeName.value,
    })
    lines.value = result.tokens.map((line) => line.map((token) => ({
      content: token.content,
      color: token.color,
      fontStyle: token.fontStyle ?? 0,
    })))
  } catch {
    lines.value = null
    failed.value = true
  }
}

onMounted(() => { void highlight() })
watch(() => [props.code, props.language, props.dark], () => { void highlight() })
</script>

<template>
  <pre class="code-block"><code v-if="lines"><template v-for="(line, lineIndex) in lines" :key="lineIndex"><span class="code-line"><span
    v-for="(token, tokenIndex) in line"
    :key="tokenIndex"
    :style="{ color: token.color, fontStyle: token.fontStyle & 2 ? 'italic' : undefined, fontWeight: token.fontStyle & 1 ? 700 : undefined, textDecoration: token.fontStyle & 4 ? 'underline' : undefined }"
  >{{ token.content }}</span></span><br v-if="lineIndex < lines.length - 1" /></template></code><code v-else>{{ code }}</code></pre>
</template>
