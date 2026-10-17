<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowReactive, shallowRef, watch, type VNodeChild } from 'vue'
import { cloneJson } from '../../shared/json'
import { EntrySession } from '../../shared/entry-session'
import { referencesSource } from '../../shared/mapping'
import type { EntryLocation, SaveResult } from '../../shared/bridge'
import { mapVisibleRange, getAdjacentVocabularyReference } from '../../shared/protocol'
import { buildQuickAddEntry, referenceInsertLength, shiftJobSpans, type QuickAddJob } from '../../shared/quick-add'
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
  settingsRevision: string
  active: boolean
  onSaveEntry: (location: EntryLocation, lemma: string, value: JsonValue) => Promise<SaveResult>
  onDeleteEntry: (documentId: string, lemma: string, baseRevision?: string) => Promise<boolean>
  onEditEntry: (documentId: string, baseRevision: string | undefined, lemma: string, value: JsonValue) => Promise<SaveResult>
}>()
const emit = defineEmits<{
  unsaved: [value: boolean]
}>()

const readerRoot = ref<HTMLElement | null>(null)
const selectedContext = ref<SelectionContext | null>(null)
const selectionError = ref('')
const composerOpen = ref(false)
const session = shallowRef<EntrySession>()
const quickJobs = shallowRef<QuickAddJob[]>([])
const quickNotice = ref('')
const inFlightRequests = new Map<string, string>()
const removalTimers = new Set<number>()
let lastKnownRevision: string | undefined
let draining = false
const cardEditing = ref(false)
const hoverSentence = ref<string>()
const hoverArticleError = ref('')
const capturedHover = shallowRef<VocabRecord>()
let hoverRequest = 0
// 选区锚点：捕获时的 client 矩形 + 阅读区滚动偏移，滚动/缩放时重新定位。
const selectionAnchor = shallowRef<{ rect: { top: number; bottom: number; left: number; right: number }; scrollTop: number; scrollLeft: number } | null>(null)
const anchorTick = ref(0)
const toolbarElement = ref<HTMLElement | null>(null)
const panelElement = ref<HTMLElement | null>(null)
const viewportSize = ref({ width: window.innerWidth, height: window.innerHeight })
let anchorObserver: ResizeObserver | undefined
let anchorFrame: number | undefined
const hoverLemma = ref('')
const hoverPoint = ref({ x: 0, y: 0 })
const imageStates = reactive<Record<string, { src: string; busy: boolean; tried: boolean; error: boolean }>>({})
let hoverTimer: number | undefined
let closeTimer: number | undefined

const parsed = computed(() => props.tab.document.parsed)
const entries = computed(() => parsed.value.entries)
const tree = computed(() => parsed.value.tree as unknown as AstNode)
const hoveredEntry = computed(() => hoverLemma.value ? entries.value.get(hoverLemma.value) ?? capturedHover.value ?? null : null)
const hasBlockingDiagnostics = computed(() => !parsed.value.writable || !!props.tab.document.error)
const quickAdd = computed(() => props.settings.quickAdd === true)
const diagnostics = computed(() => parsed.value.diagnostics)
const orphanReferences = computed(() => {
  const found: string[] = []
  const walk = (node: AstNode) => {
    const children = node.children ?? []
    children.forEach((child, index) => {
      let previous = index - 1
      while (previous >= 0 && children[previous].type === 'footnoteReference' && !entryLemmaFor(children[previous])) previous--
      if (child.type === 'footnoteReference' && entryLemmaFor(child) && (previous < 0 || !canDecorate(children[previous]))) {
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

function refreshAnchor() {
  viewportSize.value = { width: window.innerWidth, height: window.innerHeight }
  anchorTick.value++
}

function scheduleAnchorRefresh() {
  if (anchorFrame !== undefined) return
  anchorFrame = window.requestAnimationFrame(() => { anchorFrame = undefined; refreshAnchor() })
}

const selectionRect = computed(() => {
  void anchorTick.value // 滚动/缩放后重新读取阅读区滚动偏移
  const base = selectionAnchor.value
  if (!base) return null
  const root = readerRoot.value
  const deltaY = base.scrollTop - (root?.scrollTop ?? 0)
  const deltaX = base.scrollLeft - (root?.scrollLeft ?? 0)
  return { top: base.rect.top + deltaY, bottom: base.rect.bottom + deltaY, left: base.rect.left + deltaX, right: base.rect.right + deltaX }
})

const anchorVisible = computed(() => {
  void anchorTick.value
  const rect = selectionRect.value
  if (!rect) return false
  return rect.bottom > 0 && rect.top < viewportSize.value.height && rect.right > 0 && rect.left < viewportSize.value.width
})

/** 贴着选区显示：默认在下方，空间不足时翻到上方，并横向夹紧在视口内。 */
function placeNearSelection(element: HTMLElement | null, fallback: { width: number; height: number }) {
  const rect = selectionRect.value
  if (!rect) return {}
  const width = element?.offsetWidth || fallback.width
  const height = element?.offsetHeight || fallback.height
  const margin = 12
  const left = Math.max(margin, Math.min(rect.left, viewportSize.value.width - width - margin))
  const below = rect.bottom + 8
  const top = below + height <= viewportSize.value.height - margin ? below : Math.max(margin, rect.top - height - 8)
  return { left: `${left}px`, top: `${top}px` }
}

const toolbarStyle = computed(() => {
  void anchorTick.value
  return anchorVisible.value ? placeNearSelection(toolbarElement.value, { width: 240, height: 40 }) : { display: 'none' }
})
const panelStyle = computed(() => {
  void anchorTick.value
  return placeNearSelection(panelElement.value, { width: Math.min(480, viewportSize.value.width - 24), height: Math.min(360, viewportSize.value.height - 32) })
})

// 面板出现或内容变化后按真实尺寸重新定位。
watch([toolbarElement, panelElement], ([toolbar, panel]) => {
  anchorObserver?.disconnect()
  const element = panel ?? toolbar
  if (element) {
    anchorObserver ??= new ResizeObserver(() => scheduleAnchorRefresh())
    anchorObserver.observe(element)
  }
  void nextTick(refreshAnchor)
}, { flush: 'post' })

function inspectSelection() {
  if (composerOpen.value || cardEditing.value) return
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !readerRoot.value) {
    selectedContext.value = null
    selectionAnchor.value = null
    selectionError.value = ''
    return
  }
  const range = selection.getRangeAt(0)
  const startRun = elementFor(range.startContainer)?.closest<HTMLElement>('[data-text-run]')
  const endRun = elementFor(range.endContainer)?.closest<HTMLElement>('[data-text-run]')
  if (!startRun || !endRun || startRun !== endRun || !readerRoot.value.contains(startRun)) {
    selectedContext.value = null
    selectionAnchor.value = null
    selectionError.value = '请选择同一段普通文本中的一个英文单词。'
    return
  }
  const index = Number(startRun.dataset.textRun)
  const textRun = parsed.value.textRuns[index]
  if (!textRun) {
    selectedContext.value = null
    selectionAnchor.value = null
    selectionError.value = '无法将所选文字映射到文档源码。'
    return
  }
  if (textRun.ancestorTypes.some((type) => ['link', 'linkReference', 'inlineCode', 'code', 'html'].includes(type))) {
    selectedContext.value = null
    selectionAnchor.value = null
    selectionError.value = '代码、链接和原始 HTML 暂不支持存词。'
    return
  }
  const from = visibleOffset(startRun, range.startContainer, range.startOffset)
  const to = visibleOffset(startRun, range.endContainer, range.endOffset)
  const result = mapVisibleRange(parsed.value, textRun.sourceSpan, from, to)
  if (!result.ok) {
    selectedContext.value = null
    selectionAnchor.value = null
    selectionError.value = result.reason
    return
  }
  const rect = range.getBoundingClientRect()
  selectedContext.value = {
    sourceSpan: result.span,
    selected: result.selected,
    documentId: props.tab.id,
    baseRevision: props.tab.document.snapshot.revision,
  }
  selectionAnchor.value = {
    rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    scrollTop: readerRoot.value.scrollTop,
    scrollLeft: readerRoot.value.scrollLeft,
  }
  refreshAnchor()
  selectionError.value = ''
}

function cancelRequest() {
  const id = session.value?.requestId
  if (session.value) session.value.requestId = undefined
  if (id) void window.caretlex.cancelProvider(id).catch(() => undefined)
}
function closeComposer() {
  cancelRequest(); composerOpen.value = false; session.value = undefined
}
async function startComposer() {
  inspectSelection()
  if (!selectedContext.value || hasBlockingDiagnostics.value || !props.settingsAvailable) return
  const location = { ...selectedContext.value, sourceSpan: { ...selectedContext.value.sourceSpan } }
  const adjacent = getAdjacentVocabularyReference(parsed.value, location.sourceSpan)
  const bound = adjacent?.label?.match(/^w-([a-z]+(?:['-][a-z]+)*)$/)?.[1]
  // Source JSON keys are data, including names that coincide with Vue's proxy flags.
  const current = shallowReactive(new EntrySession(location, props.settings, props.settingsRevision, new Map(entries.value), bound)) as EntrySession
  session.value = current; composerOpen.value = true
  try {
    const article = await window.caretlex.getArticle(location)
    if (session.value !== current || current.invalid || !props.active) return
    if (!article.ok) { current.error = article.error.message; current.issues.push(article.error); return }
    current.setArticle(article.value)
    if (props.settings.providers.some(profile => profile.enabled && referencesSource(props.settings.saveTemplate, profile.name))) await fetchSources()
  } catch (error) { if (session.value === current) current.error = error instanceof Error ? error.message : String(error) }
}
async function fetchSources() {
  const current = session.value
  if (!current || current.invalid || current.saving || !props.settingsAvailable || !props.active) return
  cancelRequest()
  const id = crypto.randomUUID(); current.startRequest(id)
  try {
    const result = await window.caretlex.fetchSources(cloneJson({ ...current.location, requestId: id, settingsRevision: current.settingsRevision }))
    if (session.value === current) current.receive(result)
  } catch (error) { current.requestFailed(id, error instanceof Error ? error.message : String(error)) }
}
async function onComposerSubmit() {
  const current = session.value
  if (!current) return
  const value = current.parse()
  if (!value.ok) { current.error = value.message; return }
  cancelRequest()
  if (!current.confirm()) return
  try {
    await props.onSaveEntry(current.location, current.lemma, value.value)
    if (session.value === current) { closeComposer(); window.getSelection()?.removeAllRanges() }
  } catch (error) { current.error = error instanceof Error ? error.message : '保存失败，草稿保留。' }
  finally { current.saving = false }
}
function jobById(id: string) { return quickJobs.value.find(job => job.id === id) }
function updateJob(id: string, patch: Partial<QuickAddJob>) {
  quickJobs.value = quickJobs.value.map(job => job.id === id ? { ...job, ...patch } : job)
}
function dropJob(id: string) { quickJobs.value = quickJobs.value.filter(job => job.id !== id) }
function quickMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
function hasAutoSource() {
  return props.settings.providers.some(profile => profile.enabled && referencesSource(props.settings.saveTemplate, profile.name))
}
function quickJobLabel(job: QuickAddJob) {
  const reason = job.notice ? ` — ${job.notice}` : ''
  if (job.state === 'queued') return `等待获取：${job.location.selected}`
  if (job.state === 'fetching') return `正在获取：${job.location.selected}`
  if (job.state === 'saving') return `正在写入：${job.lemma}${reason}`
  if (job.state === 'saved') return `${job.usedSources ? `已保存：${job.lemma}` : `已保存（无自动释义）：${job.lemma}`}${reason}`
  return `保存失败：${job.lemma} — ${job.failure ?? '未知原因'}`
}
function cancelQuickRequests() {
  for (const requestId of inFlightRequests.values()) void window.caretlex.cancelProvider(requestId).catch(() => undefined)
  inFlightRequests.clear()
}
function scheduleJobRemoval(id: string) {
  const timer = window.setTimeout(() => { removalTimers.delete(timer); dropJob(id) }, 6000)
  removalTimers.add(timer)
}
async function runQuickRequest(id: string) {
  const job = jobById(id)
  if (!job) return
  const requestId = crypto.randomUUID()
  inFlightRequests.set(id, requestId)
  try {
    const result = await window.caretlex.fetchSources(cloneJson({ ...job.location, requestId, settingsRevision: props.settingsRevision }))
    if (!jobById(id)) return
    // 没有取得来源数据时，用 provider 的诊断说明为什么写成空释义。
    const fetched = Object.keys(result.sources).some(name => name !== 'article')
    const issue = result.issues.find(item => item.sourcePath) ?? result.issues[0]
    updateJob(id, { result, notice: fetched ? undefined : issue?.message ?? '未取得来源数据。' })
  } catch (error) {
    if (jobById(id)) updateJob(id, { notice: quickMessage(error) })
  } finally { inFlightRequests.delete(id) }
}
async function startQuickAdd() {
  inspectSelection()
  const context = selectedContext.value
  if (!context || hasBlockingDiagnostics.value || !props.settingsAvailable) return
  if (!props.tab.document.snapshot.path) { quickNotice.value = '文档尚未保存到磁盘；请先保存后再存词。'; return }
  const location: EntryLocation = { ...context, sourceSpan: { ...context.sourceSpan } }
  const adjacent = getAdjacentVocabularyReference(parsed.value, location.sourceSpan)
  const bound = adjacent?.label?.match(/^w-([a-z]+(?:['-][a-z]+)*)$/)?.[1]
  const job: QuickAddJob = {
    id: crypto.randomUUID(), location, boundLemma: bound, lemma: bound ?? location.selected.toLowerCase(), state: 'queued', usedSources: false
  }
  if (!quickJobs.value.length) lastKnownRevision = props.tab.document.snapshot.revision
  quickJobs.value = [...quickJobs.value, job]
  quickNotice.value = ''
  // 同一个词形不重复入队：清掉选区，用户继续阅读。
  window.getSelection()?.removeAllRanges()
  selectedContext.value = null
  selectionAnchor.value = null
  await drainQuickAdd()
}
async function drainQuickAdd() {
  if (draining) return
  draining = true
  try {
    for (;;) {
      const next = quickJobs.value.find(job => job.state === 'queued')
      if (!next) return
      // 同步比较：本次队列自身的写入已记入 lastKnownRevision，其余变化说明文档被外部改动。
      if (props.tab.document.snapshot.revision !== lastKnownRevision) {
        quickJobs.value = []
        quickNotice.value = '文档版本已变化；未写入的快速添加已取消，请重新选词。'
        return
      }
      // 一次只处理一个任务：主进程在文档变化时取消该文档的全部在飞请求，
      // 并发获取会被同队列上一次写入取消。写入 revision 在出队时刷新，
      // 入队时捕获的版本早于同队列更早的写入。
      const location: EntryLocation = { ...next.location, baseRevision: props.tab.document.snapshot.revision }
      updateJob(next.id, { state: 'fetching', location })
      let notice = ''
      try {
        const article = await window.caretlex.getArticle(location)
        if (!jobById(next.id)) continue
        if (article.ok) updateJob(next.id, { article: article.value })
        else notice = article.error.message
      } catch (error) { notice = quickMessage(error) }
      if (!jobById(next.id)) continue
      if (notice) updateJob(next.id, { notice })
      else if (hasAutoSource()) await runQuickRequest(next.id)
      const job = jobById(next.id)
      if (!job) continue
      const built = buildQuickAddEntry(job, props.settings, props.settingsRevision, new Map(entries.value))
      if (!built.ok) { updateJob(job.id, { state: 'failed', failure: built.error.message }); continue }
      updateJob(job.id, { state: 'saving' })
      // planAdd 只在选区后没有同词条引用时才插入标记，插入长度决定后续排队任务的范围平移。
      const inserted = !getAdjacentVocabularyReference(parsed.value, location.sourceSpan)
      try {
        const result = await props.onSaveEntry(location, built.value.lemma, built.value.value)
        lastKnownRevision = result.snapshot.revision
        if (result.changed && inserted) quickJobs.value = shiftJobSpans(quickJobs.value, job.id, location.sourceSpan.end, referenceInsertLength(built.value.lemma))
        updateJob(job.id, { state: 'saved', lemma: built.value.lemma, usedSources: built.value.usedSources, failure: undefined })
        scheduleJobRemoval(job.id)
      } catch (error) {
        updateJob(job.id, { state: 'failed', failure: quickMessage(error) })
      }
    }
  } finally { draining = false }
}
function openQuickJob(id: string) {
  const job = jobById(id)
  if (!job) return
  const location: EntryLocation = { ...job.location, baseRevision: props.tab.document.snapshot.revision }
  const current = shallowReactive(new EntrySession(location, props.settings, props.settingsRevision, new Map(entries.value), job.boundLemma)) as EntrySession
  if (job.article) current.setArticle(job.article)
  if (job.result) { current.startRequest(job.result.requestId); current.receive(job.result) }
  current.error = job.failure ?? ''
  session.value = current
  composerOpen.value = true
  dropJob(id)
}
async function deleteHovered() {
  const lemma = hoveredEntry.value?.lemma
  if (!lemma) return
  const saved = await props.onDeleteEntry(props.tab.id, lemma, props.tab.document.snapshot.revision)
  if (saved) { hoverLemma.value = ''; cardEditing.value = false }
}
async function loadHoverArticle(location: EntryLocation) {
  const id = ++hoverRequest; hoverSentence.value = undefined; hoverArticleError.value = ''
  try {
    const article = await window.caretlex.getArticle(location)
    if (id !== hoverRequest) return
    if (article.ok) hoverSentence.value = article.value.original_sentence
    else hoverArticleError.value = article.error.message
  } catch (error) { if (id === hoverRequest) hoverArticleError.value = error instanceof Error ? error.message : String(error) }
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
    const run = parsed.value.textRuns[index]
    const mapped = run ? mapVisibleRange(parsed.value, run.sourceSpan, match.index, text.length) : undefined
    const location: EntryLocation | undefined = mapped?.ok ? { documentId: props.tab.id, baseRevision: props.tab.document.snapshot.revision, sourceSpan: mapped.span, selected: mapped.selected } : undefined
    content.push(h('span', {
      class: 'vocab-anchor',
      role: 'button',
      tabindex: 0,
      'aria-label': `查看 ${anchorLemma} 词条`,
      onMouseenter: (event: MouseEvent) => showEntryAfterDelay(anchorLemma!, event, location),
      onMouseleave: scheduleCardClose,
      onFocus: (event: FocusEvent) => showEntryImmediately(anchorLemma!, event, location),
      onClick: (event: MouseEvent) => showEntryImmediately(anchorLemma!, event, location),
      onKeydown: (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') showEntryImmediately(anchorLemma!, event, location) },
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
    let referenceIndex = index + 1
    while (children[referenceIndex]?.type === 'footnoteReference' && !entryLemmaFor(children[referenceIndex])) referenceIndex++
    const next = children[referenceIndex]
    const nextLemma = next?.type === 'footnoteReference' ? entryLemmaFor(next) : null
    if (nextLemma && canDecorate(node)) {
      output.push(renderNode(node, nextLemma))
      for (let ordinary = index + 1; ordinary < referenceIndex; ordinary++) output.push(renderFootnoteReference(children[ordinary]))
      index = referenceIndex
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

function showEntryAfterDelay(lemma: string, event: MouseEvent, location?: EntryLocation) {
  if (cardEditing.value) return
  if (hoverTimer !== undefined) window.clearTimeout(hoverTimer)
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  hoverTimer = window.setTimeout(() => {
    hoverLemma.value = lemma
    capturedHover.value = entries.value.get(lemma)
    if (location) void loadHoverArticle(location)
    else { hoverSentence.value = undefined; hoverArticleError.value = '无法定位该词形的真实源范围。' }
    hoverPoint.value = { x: rect.left, y: rect.bottom + 8 }
  }, 300)
}

function showEntryImmediately(lemma: string, event: MouseEvent | FocusEvent | KeyboardEvent, location?: EntryLocation) {
  if (cardEditing.value) return
  if (hoverTimer !== undefined) window.clearTimeout(hoverTimer)
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  hoverLemma.value = lemma
  capturedHover.value = entries.value.get(lemma)
  if (location) void loadHoverArticle(location)
  else { hoverSentence.value = undefined; hoverArticleError.value = '无法定位该词形的真实源范围。' }
  hoverPoint.value = { x: rect.left, y: rect.bottom + 8 }
}

function scheduleCardClose() {
  if (cardEditing.value) return
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

watch(() => composerOpen.value || cardEditing.value || quickJobs.value.length > 0, value => emit('unsaved', value))
watch(() => props.tab.document.snapshot.revision, () => {
  selectedContext.value = null
  selectionAnchor.value = null
  if (session.value && !session.value.saving) { cancelRequest(); session.value.invalidate('文档版本已变化；编辑稿保留，请关闭此稿并按新正文重新开始。') }
  if (!cardEditing.value) hoverLemma.value = ''
  ++hoverRequest
})
watch(() => props.tab.document.error, error => {
  if (!error) return
  if (session.value) { cancelRequest(); session.value.invalidate(error) }
  cancelQuickRequests(); quickJobs.value = []
})
watch(() => props.settingsRevision, () => {
  cancelRequest()
  if (session.value) {
    if (props.settingsAvailable) session.value.replaceSettings(props.settings, props.settingsRevision)
    else session.value.error = '设置不可用；自动获取已取消，手改稿仍可保存。'
  }
  // 在飞请求按旧保存配置发起，主进程也会以 SETTINGS_CONFLICT 拒绝，直接取消并退回本地 article。
  cancelQuickRequests()
  void drainQuickAdd()
})
watch(() => props.active, active => { if (!active) { cancelRequest(); ++hoverRequest } })
onMounted(() => { window.addEventListener('resize', scheduleAnchorRefresh) })
onBeforeUnmount(() => {
  cancelRequest(); cancelQuickRequests(); ++hoverRequest; emit('unsaved', false)
  for (const timer of removalTimers) window.clearTimeout(timer)
  removalTimers.clear()
  quickJobs.value = []
  window.removeEventListener('resize', scheduleAnchorRefresh)
  anchorObserver?.disconnect()
  if (anchorFrame !== undefined) window.cancelAnimationFrame(anchorFrame)
  if (hoverTimer !== undefined) window.clearTimeout(hoverTimer)
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
})
</script>

<template>
  <div class="reader-layout">
    <div v-if="tab.document.error" class="notice notice-error" role="alert">{{ tab.document.error }}；稿件保留，无法使用旧范围提交。</div>
    <div v-if="hasBlockingDiagnostics" class="notice notice-error reader-blocking-notice" role="alert">
      文档结构存在问题，存词和导出已停用。修复源码后再试。
    </div>
    <div v-if="orphanReferences.length" class="notice notice-warning reader-blocking-notice" role="status">
      词条引用 {{ orphanReferences.join('、') }} 前没有可识别的原文词形；保留脚注标记供检查。
    </div>
    <div v-if="!settingsAvailable" class="notice notice-error reader-blocking-notice" role="status">
      设置文件无法读取。恢复设置 JSON 后才能存词；当前阅读和源码仍可使用。
    </div>
    <div class="reader-scroll" ref="readerRoot" @mouseup="inspectSelection" @keyup="inspectSelection" @scroll="scheduleAnchorRefresh">
      <MarkdownBody />
    </div>

    <div v-if="selectionError" class="selection-message" role="status">{{ selectionError }}</div>
    <div v-if="selectedContext && !composerOpen" ref="toolbarElement" class="selection-toolbar" :style="toolbarStyle">
      <span>已选：{{ selectedContext.selected }}</span>
      <button class="button button-primary button-small" type="button" :disabled="hasBlockingDiagnostics || !settingsAvailable" @mousedown.prevent="quickAdd ? startQuickAdd() : startComposer()">{{ quickAdd ? '快速添加' : '存为词条' }}</button>
    </div>

    <div v-if="quickNotice || quickJobs.length" class="quick-status" role="status">
      <p v-if="quickNotice" class="quick-status-row quick-status-notice"><span>{{ quickNotice }}</span><button class="text-button" type="button" @click="quickNotice = ''">关闭</button></p>
      <p v-for="job in quickJobs" :key="job.id" class="quick-status-row" :class="{ 'error-text': job.state === 'failed' }">
        <span>{{ quickJobLabel(job) }}</span>
        <button v-if="job.state === 'failed'" class="text-button" type="button" @click="openQuickJob(job.id)">打开录入窗</button>
        <button v-if="job.state === 'failed'" class="text-button" type="button" @click="dropJob(job.id)">忽略</button>
      </p>
    </div>

    <div v-if="composerOpen && session" ref="panelElement" class="floating-panel" :style="panelStyle">
      <EntryComposer :session="session" :busy="busy" @cancel="closeComposer" @submit="onComposerSubmit" @retry="fetchSources" />
    </div>
    <VocabCard v-if="hoveredEntry" :entry="hoveredEntry" :x="hoverPoint.x" :y="hoverPoint.y" :busy="busy"
      :sentence="hoverSentence" :article-error="hoverArticleError" :document-id="tab.id" :revision="tab.document.snapshot.revision" :on-save="onEditEntry"
      @editing="cardEditing = $event" @stay="keepCardOpen" @leave="scheduleCardClose" @close="hoverLemma = ''; cardEditing = false; ++hoverRequest" @delete="deleteHovered" />

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
