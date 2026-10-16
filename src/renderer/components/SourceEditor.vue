<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { keymap } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'

const props = defineProps<{ modelValue: string; dark: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null
const themeCompartment = new Compartment()

function editorTheme(dark: boolean) {
  const foreground = dark ? '#e5e8ee' : '#252a34'
  const background = dark ? '#171b22' : '#ffffff'
  const gutter = dark ? '#14171d' : '#f3f5f8'
  return EditorView.theme({
    '&': { color: foreground, backgroundColor: background, height: '100%', fontSize: '14px' },
    '.cm-content': { caretColor: dark ? '#e6b55f' : '#956300', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', minHeight: '100%' },
    '.cm-gutters': { backgroundColor: gutter, color: dark ? '#818b9c' : '#788292', border: 'none' },
    '.cm-activeLine': { backgroundColor: dark ? '#212630' : '#f7f8fa' },
    '.cm-activeLineGutter': { backgroundColor: dark ? '#212630' : '#f7f8fa' },
    '.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: dark ? '#384153' : '#dce7fb' },
    '.cm-cursor': { borderLeftColor: dark ? '#e6b55f' : '#956300' },
  }, { dark })
}

onMounted(() => {
  if (!host.value) return
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      markdown(),
      keymap.of([
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      themeCompartment.of(editorTheme(props.dark)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
      }),
    ],
  })
  view = new EditorView({ state, parent: host.value })
})

watch(() => props.modelValue, (next) => {
  if (!view || view.state.doc.toString() === next) return
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
})

watch(() => props.dark, (dark) => {
  if (!view) return
  view.dispatch({ effects: themeCompartment.reconfigure(editorTheme(dark)) })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})
</script>

<template>
  <div ref="host" class="source-editor-host" :data-theme="dark ? 'dark' : 'light'" aria-label="Markdown 源码编辑器"></div>
</template>
