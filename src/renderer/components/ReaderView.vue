<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, reactive, ref, watch, type VNodeChild } from 'vue'
import { mapVisibleRange } from '../../shared/protocol'
import EntryComposer from './EntryComposer.vue'
import VocabCard from './VocabCard.vue'
import CodeBlock from './CodeBlock.vue'
import type { AppSettings } from '../../shared/settings'
import type { DocumentResult, JsonValue, SelectionContext, VocabRecord, WorkspaceTab } from '../types'

interface AstPosition { start?: { offset?: number }; end?: { offset?: number } }
interface AstNode {
  type: string
  value?: unknown
  children?: AstNode[]
  position?: AstPosition
  depth?: number
  ordered?: boolean
  start?: number
  checked?: boolean | null
  identifier?: string
  label?: string
  url?: string
  title?: string | null
  alt?: string | null
  align?: Array<'left' | 'right' | 'center' | null>
  [key: string]: unknown
}

const props = defineProps<{
  tab: WorkspaceTab
  busy?: boolean
  dark: boolean
  settings: AppSettings
  settingsAvailable: boolean
  template: JsonValue
  defaultBindings: boolean
}>()
const emit = defineEmits<{
  add: [selection: SelectionContext, lemma: string, value: JsonValue, complete: (saved: boolean) => void]
  edit: [lemma: string, value: JsonValue]
  delete: [lemma: string]
}>()

const readerRoot = ref<HTMLElement | null>(null)
const selectedContext = ref<SelectionContext | null>(null)
const selectionError = ref('')
const composerOpen = ref(false)
const selectionPoint = ref({ x: 0, y: 0 })
const hoverLemma = ref('')
const hoverPoint = ref({ x: 0, y: 0 })
const imageStates = reactive<Record<string, { src: string; busy: boolean; tried: boolean; error: boolean }>>({})
let hoverTimer: number | undefined
let closeTimer: number | undefined

const parsed = computed(() => props.tab.document.parsed)
const entries = computed(() => parsed.value.entries)
const tree = computed(() => parsed.value.tree as unknown as AstNode)
const hoveredEntry = computed(() => entries.value.get(hoverLemma.value) ?? null)
const hasBlockingDiagnostics = computed(() => !parsed.value.writable)
const diagnostics = computed(() => parsed.value.diagnostics)
const orphanReferences = computed(() => {
  const found: string[] = []
  const walk = (node: AstNode) => {
    const children = node.children ?? []
    children.forEach((child, index) => {
      if (child.type === 'footnoteReference' && entryLemmaFor(child) && (!index || !canDecorate(children[index - 1]))) {
        found.push(String(child.identifier ?? child.label ?? '').slice(2))
      }
      walk(child)
    })
  }
  walk(tree.value)
  return [...new Set(found)]
})

function nodeRange(node: AstNode) {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null
}

function textRunIndex(node: AstNode) {
  const range = nodeRange(node)
  if (!range) return -1
  return parsed.value.textRuns.findIndex((run) => run.sourceSpan.start === range.start && run.sourceSpan.end === range.end)
}

function nodeText(node: AstNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code' || node.type === 'html') return String(node.value ?? '')
  return (node.children ?? []).map(nodeText).join(node.type === 'break' ? '\n' : '')
}

function sentenceAround(value: string, start: number, end: number) {
  let left = start
  let right = end
  while (left > 0 && !/[.!?\n]/.test(value[left - 1])) left -= 1
  while (right < value.length && !/[.!?\n]/.test(value[right])) right += 1
  if (right < value.length && /[.!?]/.test(value[right])) right += 1
  const sentence = value.slice(left, right).trim()
  return sentence || value.trim()
}

function sentenceContext(sourceSpan: { start: number; end: number }, visibleStart: number, visibleEnd: number, fallback: string) {
  function findBlock(node: AstNode, nearest?: AstNode): AstNode | undefined {
    const range = nodeRange(node)
    if (!range || range.start > sourceSpan.start || range.end < sourceSpan.end) return undefined
    const candidate = ['paragraph', 'heading', 'tableCell'].includes(node.type) ? node : nearest
    for (const child of node.children ?? []) {
      const found = findBlock(child, candidate)
      if (found) return found
    }
    return candidate
  }
  const block = findBlock(tree.value)
  if (!block) return fallback

  function collect(node: AstNode): { text: string; selectedStart?: number; selectedEnd?: number } {
    if (node.type === 'footnoteReference' || node.type === 'definition') return { text: '' }
    if (node.type === 'break') return { text: '\n' }
    if (node.type === 'image' || node.type === 'imageReference') return { text: String(node.alt ?? '') }
    if (!node.children?.length) {
      const text = typeof node.value === 'string' ? node.value : ''
      const range = nodeRange(node)
      if (range?.start === sourceSpan.start && range.end === sourceSpan.end) {
        return { text, selectedStart: visibleStart, selectedEnd: visibleEnd }
      }
      return { text }
    }
    let text = ''
    let selectedStart: number | undefined
    let selectedEnd: number | undefined
    for (const child of node.children) {
      const part = collect(child)
      if (selectedStart === undefined && part.selectedStart !== undefined) {
        selectedStart = text.length + part.selectedStart
        selectedEnd = text.length + (part.selectedEnd ?? part.selectedStart)
      }
      text += part.text
    }
    return { text, selectedStart, selectedEnd }
  }
  const content = collect(block)
  if (content.selectedStart === undefined || content.selectedEnd === undefined) return fallback
  return sentenceAround(content.text, content.selectedStart, content.selectedEnd)
}

function elementFor(node: Node | null) {
  if (node instanceof Element) return node
  return node?.parentElement ?? null
}

function visibleOffset(runElement: HTMLElement, node: Node, offset: number) {
  const range = document.createRange()
  range.selectNodeContents(runElement)
  range.setEnd(node, offset)
  return range.toString().length
}

function inspectSelection() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !readerRoot.value) {
    selectedContext.value = null
    selectionError.value = ''
    return
  }
  const range = selection.getRangeAt(0)
  const startRun = elementFor(range.startContainer)?.closest<HTMLElement>('[data-text-run]')
  const endRun = elementFor(range.endContainer)?.closest<HTMLElement>('[data-text-run]')
  if (!startRun || !endRun || startRun !== endRun || !readerRoot.value.contains(startRun)) {
    selectedContext.value = null
    selectionError.value = '请选择同一段普通文本中的一个英文单词。'
    return
  }
  const index = Number(startRun.dataset.textRun)
  const textRun = parsed.value.textRuns[index]
  if (!textRun) {
    selectedContext.value = null
    selectionError.value = '无法将所选文字映射到文档源码。'
    return
  }
  if (textRun.ancestorTypes.some((type) => ['link', 'linkReference', 'inlineCode', 'code', 'html'].includes(type))) {
    selectedContext.value = null
    selectionError.value = '代码、链接和原始 HTML 暂不支持存词。'
    return
  }
  const from = visibleOffset(startRun, range.startContainer, range.startOffset)
  const to = visibleOffset(startRun, range.endContainer, range.endOffset)
  const result = mapVisibleRange(parsed.value, textRun.sourceSpan, from, to)
  if (!result.ok) {
    selectedContext.value = null
    selectionError.value = result.reason
    return
  }
  const rect = range.getBoundingClientRect()
  selectedContext.value = {
    sourceSpan: result.span,
    selected: result.selected,
    sentence: sentenceContext(textRun.sourceSpan, from, to, sentenceAround(textRun.value, from, to)),
  }
  selectionPoint.value = {
    x: Math.max(12, Math.min(rect.left, window.innerWidth - 320)),
    y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 500)),
  }
  selectionError.value = ''
}

function startComposer() {
  inspectSelection()
  if (selectedContext.value && !hasBlockingDiagnostics.value && props.settingsAvailable) composerOpen.value = true
  else if (selectedContext.value && !props.settingsAvailable) selectionError.value = '设置文件无法读取，请先在设置页恢复设置后再存词。'
}

function onComposerSubmit(value: { lemma: string; value: JsonValue }) {
  if (!selectedContext.value) return
  emit('add', selectedContext.value, value.lemma, value.value, (saved) => {
    if (!saved) return
    composerOpen.value = false
    window.getSelection()?.removeAllRanges()
  })
}

function entryLemmaFor(node: AstNode): string | null {
  const range = nodeRange(node)
  const reference = range
    ? parsed.value.footnoteReferences.find((item) => item.span.start === range.start && item.span.end === range.end)
    : undefined
  const rawLabel = String(node.label ?? reference?.label ?? '')
  const match = /^w-([a-z]+(?:['-][a-z]+)*)$/.exec(rawLabel)
  if (!match) return null
  const lemma = match[1]
  return entries.value.has(lemma) ? lemma : null
}

function isManagedMarker(node: AstNode) {
  if (!parsed.value.managedBlock.valid) return false
  const range = nodeRange(node)
  if (!range) return false
  const markers = [parsed.value.managedBlock.startMarkerSpan, parsed.value.managedBlock.endMarkerSpan]
  return markers.some((marker) => marker && range.start <= marker.start && range.end >= marker.end)
}

function canDecorate(node: AstNode): boolean {
  if (node.type === 'text') return /[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(String(node.value ?? ''))
  if (['emphasis', 'strong', 'delete'].includes(node.type)) {
    const children = node.children ?? []
    return children.length > 0 && canDecorate(children[children.length - 1])
  }
  return false
}

function textVNode(node: AstNode, anchorLemma?: string): VNodeChild {
  const text = String(node.value ?? '')
  const index = textRunIndex(node)
  const match = anchorLemma ? /[A-Za-z]+(?:['-][A-Za-z]+)*$/.exec(text) : null
  const content: VNodeChild[] = []
  if (match) {
    if (match.index > 0) content.push(text.slice(0, match.index))
    const word = text.slice(match.index)
    content.push(h('span', {
      class: 'vocab-anchor',
      role: 'button',
      tabindex: 0,
      'aria-label': `查看 ${anchorLemma} 词条`,
      onMouseenter: (event: MouseEvent) => showEntryAfterDelay(anchorLemma!, event),
      onMouseleave: scheduleCardClose,
      onFocus: (event: FocusEvent) => showEntryImmediately(anchorLemma!, event),
      onClick: (event: MouseEvent) => showEntryImmediately(anchorLemma!, event),
      onKeydown: (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') showEntryImmediately(anchorLemma!, event) },
    }, word))
  } else {
    content.push(text)
  }
  return h('span', { class: 'markdown-text-run', 'data-text-run': index >= 0 ? String(index) : undefined }, content)
}

function isReference(node: AstNode, lemma?: string | null): boolean {
  return node.type === 'footnoteReference' && (lemma === undefined ? true : entryLemmaFor(node) === lemma)
}

function renderInlineChildren(children: AstNode[], finalAnchor?: string): VNodeChild[] {
  const output: VNodeChild[] = []
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index]
    const next = children[index + 1]
    const nextLemma = next?.type === 'footnoteReference' ? entryLemmaFor(next) : null
    if (nextLemma && canDecorate(node)) {
      output.push(renderNode(node, nextLemma))
      index += 1
      continue
    }
    if (node.type === 'footnoteReference' && entryLemmaFor(node)) {
      output.push(renderFootnoteReference(node))
      continue
    }
    output.push(renderNode(node, index === children.length - 1 ? finalAnchor : undefined))
  }
  return output
}

function renderFootnoteReference(node: AstNode): VNodeChild {
  const label = String(node.label ?? node.identifier ?? '?')
  return h('sup', { class: 'footnote-reference' }, [h('a', { role: 'link', tabindex: 0, 'aria-label': `脚注 ${label}` }, label)])
}

function showEntryAfterDelay(lemma: string, event: MouseEvent) {
  if (hoverTimer !== undefined) window.clearTimeout(hoverTimer)
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  hoverTimer = window.setTimeout(() => {
    hoverLemma.value = lemma
    hoverPoint.value = { x: rect.left, y: rect.bottom + 8 }
  }, 300)
}

function showEntryImmediately(lemma: string, event: MouseEvent | FocusEvent | KeyboardEvent) {
  if (hoverTimer !== undefined) window.clearTimeout(hoverTimer)
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  hoverLemma.value = lemma
  hoverPoint.value = { x: rect.left, y: rect.bottom + 8 }
}

function scheduleCardClose() {
  if (hoverTimer !== undefined) window.clearTimeout(hoverTimer)
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => { hoverLemma.value = '' }, 250)
}

function keepCardOpen() {
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
}

function getImageState(source: string) {
  return imageStates[source] ?? { src: '', busy: false, tried: false, error: false }
}

async function requestImage(source: string, remote: boolean) {
  if (imageStates[source]?.tried || imageStates[source]?.busy) return
  imageStates[source] = { src: '', busy: true, tried: false, error: false }
  try {
    const uri = remote
      ? await window.caretlex.loadRemoteImage(source)
      : await window.caretlex.loadLocalImage(props.tab.id, source)
    imageStates[source] = { src: uri ?? '', busy: false, tried: true, error: !uri }
  } catch {
    imageStates[source] = { src: '', busy: false, tried: true, error: true }
  }
}

function renderImage(node: AstNode): VNodeChild {
  const source = String(node.url ?? '')
  const alt = String(node.alt ?? '图片')
  const remote = /^https?:\/\//i.test(source)
  const state = getImageState(source)
  if (state.src) return h('img', { class: 'markdown-image', src: state.src, alt, title: String(node.title ?? alt) })
  if (!remote && !state.tried && !state.busy) {
    return h('span', { class: 'image-placeholder', onVnodeMounted: () => { void requestImage(source, false) } }, state.busy ? '正在读取图片…' : `图片：${alt}`)
  }
  return h('button', {
    class: 'image-placeholder',
    type: 'button',
    disabled: state.busy,
    onClick: () => { void requestImage(source, remote) },
  }, state.busy ? '正在加载图片…' : state.error ? `无法加载：${alt}` : remote ? `加载远程图片：${alt}` : `图片：${alt}`)
}

function safeLinkClick(event: MouseEvent, rawUrl: string) {
  event.preventDefault()
  try {
    const parsedUrl = new URL(rawUrl)
    if (['https:', 'http:', 'mailto:'].includes(parsedUrl.protocol)) void window.caretlex.openExternal(parsedUrl.toString())
  } catch {
    // Relative links and malformed URLs remain inert in the first release.
  }
}

function renderNode(node: AstNode, anchorLemma?: string): VNodeChild {
  const children = node.children ?? []
  const inline = () => renderInlineChildren(children, anchorLemma)
  const blocks = () => children.map((child) => renderNode(child))
  switch (node.type) {
    case 'root': return h('div', { class: 'markdown-content' }, blocks())
    case 'text': return textVNode(node, anchorLemma)
    case 'paragraph': return h('p', { class: 'markdown-paragraph' }, inline())
    case 'heading': return h(`h${Math.max(1, Math.min(6, Number(node.depth ?? 1)))}`, { class: 'markdown-heading' }, inline())
    case 'emphasis': return h('em', inline())
    case 'strong': return h('strong', inline())
    case 'delete': return h('del', inline())
    case 'inlineCode': return h('code', { class: 'inline-code' }, String(node.value ?? ''))
    case 'code': return h(CodeBlock, { code: String(node.value ?? ''), language: String(node.lang ?? 'text'), dark: props.dark })
    case 'blockquote': return h('blockquote', blocks())
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul'
      return h(tag, { start: node.ordered && typeof node.start === 'number' ? node.start : undefined, class: 'markdown-list' }, blocks())
    }
    case 'listItem': {
      const items: VNodeChild[] = []
      if (typeof node.checked === 'boolean') items.push(h('input', { type: 'checkbox', checked: node.checked, disabled: true, class: 'task-checkbox' }))
      items.push(...blocks())
      return h('li', { class: node.checked !== undefined && node.checked !== null ? 'task-list-item' : undefined }, items)
    }
    case 'table': {
      const rows = children
      const tableRows = rows.map((row, rowIndex) => h(rowIndex === 0 ? 'thead' : 'tbody', null, [
        h('tr', (row.children ?? []).map((cell, columnIndex) => h(rowIndex === 0 ? 'th' : 'td', {
          style: { textAlign: node.align?.[columnIndex] ?? undefined },
        }, renderInlineChildren(cell.children ?? [])))),
      ]))
      return h('div', { class: 'table-scroll' }, [h('table', { class: 'markdown-table' }, tableRows)])
    }
    case 'link':
    case 'linkReference':
      return h('a', {
        class: 'markdown-link',
        role: 'link',
        tabindex: 0,
        title: node.title ?? undefined,
        onClick: (event: MouseEvent) => safeLinkClick(event, String(node.url ?? '')),
        onKeydown: (event: KeyboardEvent) => { if (event.key === 'Enter') safeLinkClick(event as unknown as MouseEvent, String(node.url ?? '')) },
      }, inline())
    case 'image':
    case 'imageReference': return renderImage(node)
    case 'break': return h('br')
    case 'thematicBreak': return h('hr')
    case 'footnoteReference': return renderFootnoteReference(node)
    case 'footnoteDefinition': return renderFootnoteDefinition(node)
    case 'definition': return null
    case 'html': return isManagedMarker(node) ? null : h('pre', { class: 'raw-html-source' }, String(node.value ?? ''))
    case 'yaml':
    case 'toml': return h('pre', { class: 'frontmatter-source' }, String(node.value ?? ''))
    default: return children.length ? h('div', { class: 'unknown-markdown-node' }, blocks()) : (typeof node.value === 'string' ? h('span', node.value) : null)
  }
}

function renderFootnoteDefinition(node: AstNode): VNodeChild {
  if (entryLemmaFor(node)) return null
  const label = String(node.label ?? node.identifier ?? '')
  return h('li', { class: 'ordinary-footnote', id: `footnote-${label}` }, [
    h('span', { class: 'footnote-label' }, `[${label}]`),
    ...renderInlineChildren(node.children ?? []),
  ])
}

function renderDocument(): VNodeChild[] {
  const children = tree.value.children ?? []
  const blocks = children.filter((node) => node.type !== 'footnoteDefinition').map((node) => renderNode(node))
  const ordinary = children.filter((node) => node.type === 'footnoteDefinition' && !entryLemmaFor(node))
  if (ordinary.length) blocks.push(h('section', { class: 'footnotes' }, [
    h('h2', { class: 'footnotes-title' }, '脚注'),
    h('ol', ordinary.map(renderFootnoteDefinition)),
  ]))
  return blocks
}

const MarkdownBody = defineComponent(() => () => h('div', { class: 'markdown-content' }, renderDocument()))

watch(() => props.tab.document.snapshot.revision, () => {
  selectedContext.value = null
  composerOpen.value = false
  hoverLemma.value = ''
})

onBeforeUnmount(() => {
  if (hoverTimer !== undefined) window.clearTimeout(hoverTimer)
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
})
</script>

<template>
  <div class="reader-layout">
    <div v-if="hasBlockingDiagnostics" class="notice notice-error reader-blocking-notice" role="alert">
      文档结构存在问题，存词和导出已停用。修复源码后再试。
    </div>
    <div v-if="orphanReferences.length" class="notice notice-warning reader-blocking-notice" role="status">
      词条引用 {{ orphanReferences.join('、') }} 前没有可识别的原文词形；保留脚注标记供检查。
    </div>
    <div v-if="!settingsAvailable" class="notice notice-error reader-blocking-notice" role="status">
      设置文件无法读取。恢复设置 JSON 后才能存词；当前阅读和源码仍可使用。
    </div>
    <div class="reader-scroll" ref="readerRoot" @mouseup="inspectSelection" @keyup="inspectSelection">
      <MarkdownBody />
    </div>

    <div v-if="selectionError" class="selection-message" role="status">{{ selectionError }}</div>
    <div v-if="selectedContext && !composerOpen" class="selection-toolbar" :style="{ left: `${selectionPoint.x}px`, top: `${selectionPoint.y}px` }">
      <span>已选：{{ selectedContext.selected }}</span>
      <button class="button button-primary button-small" type="button" :disabled="hasBlockingDiagnostics || !settingsAvailable" @mousedown.prevent="startComposer">存为词条</button>
    </div>

    <div v-if="composerOpen && selectedContext && settingsAvailable" class="floating-panel" :style="{ left: `${selectionPoint.x}px`, top: `${selectionPoint.y}px` }">
      <EntryComposer
        :selected="selectedContext.selected"
        :sentence="selectedContext.sentence"
        :records="entries"
        :settings="settings"
        :template="template"
        :default-bindings="defaultBindings"
        :busy="busy"
        @cancel="composerOpen = false"
        @submit="onComposerSubmit"
      />
    </div>

    <VocabCard
      v-if="hoveredEntry"
      :entry="hoveredEntry"
      :x="hoverPoint.x"
      :y="hoverPoint.y"
      :busy="busy"
      @stay="keepCardOpen"
      @leave="scheduleCardClose"
      @close="hoverLemma = ''"
      @edit="(value) => emit('edit', hoveredEntry!.lemma, value)"
      @delete="emit('delete', hoveredEntry.lemma)"
    />

    <aside v-if="diagnostics.length" class="diagnostics-panel" aria-label="文档诊断">
      <details>
        <summary>诊断（{{ diagnostics.length }}）</summary>
        <ul>
          <li v-for="(diagnostic, index) in diagnostics" :key="`${diagnostic.code}-${index}`" :class="diagnostic.severity === 'error' ? 'error-text' : 'warning-text'">
            <span>{{ diagnostic.message }}</span>
            <small v-if="diagnostic.span">位置 {{ diagnostic.span.start }}–{{ diagnostic.span.end }}</small>
          </li>
        </ul>
      </details>
    </aside>
  </div>
</template>
