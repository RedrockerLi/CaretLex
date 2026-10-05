import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, isProxy, reactive, shallowReactive } from 'vue'
import { useWorkspaceStore } from '../../src/renderer/stores/workspace'
import { documentToWire } from '../../src/shared/document-wire'
import { parseDocument } from '../../src/shared/protocol'
import type { DocumentResult } from '../../src/shared/bridge'
import { EntrySession } from '../../src/shared/entry-session'
import { defaultSettings } from '../../src/shared/settings'
import { llmType, llmPreset, defaultResponse } from '../../src/shared/providers'
const initial = 'The bank.'
const note = { lemma: 'bank', contexts: [{ original_sentence: 'The [bank].', meaning_in_context: '银行', english_definition: 'institution' }], other_meanings: [] }
function wire(text: string, revision: string): DocumentResult {
  return documentToWire({ snapshot: { id: 'doc', path: '/tmp/article.md', text, revision, bom: false, eol: '\n' }, parsed: parseDocument(text) })
}
const savedText = initial.replace('bank', 'bank[^w-bank]') + '\n\n<!-- caretlex:vocab:start -->\n[^w-bank]: ' + JSON.stringify(note) + '\n<!-- caretlex:vocab:end -->\n'
afterEach(() => vi.unstubAllGlobals())
describe('workspace document snapshots', () => {
  it.each(['__proto__', 'constructor', '__v_isReactive'])('keeps %s as source data rather than a reactive proxy flag', name => {
    const settings = { ...defaultSettings, providers: [{ name, type: 'LLM', enabled: true, config: llmType.defaultConfig() }], saveTemplate: llmPreset(name) }
    const session = shallowReactive(new EntrySession({ documentId: 'doc', baseRevision: 'base', sourceSpan: { start: 4, end: 8 }, selected: 'went' }, settings, 'settings', new Map()))
    const article = { original_word: 'went', original_sentence: 'She [went].' }
    session.startRequest('request')
    session.receive({ requestId: 'request', article, sources: { article: { ...article }, [name]: { lemma: 'go', meaning_in_context: '去', english_definition: 'move', other_meanings: [] } }, examples: { [name]: defaultResponse }, issues: [] })
    expect(isProxy(session.sources)).toBe(false)
    expect(session.lemma).toBe('go')
    expect(JSON.parse(session.text).contexts[0].meaning_in_context).toBe('去')
    expect(session.parse().ok).toBe(true)
  })

  it('updates reader dependencies without destroying entry editors on every revision', () => {
    setActivePinia(createPinia()); const store = useWorkspaceStore()
    store.applyDocument(wire(initial, 'one'))
    const tab = store.tabs[0]
    const entry = computed(() => tab.document.parsed.entries.get('bank'))
    const revision = computed(() => tab.document.snapshot.revision)
    expect(entry.value).toBeUndefined()
    store.applyExternalChange(wire(savedText, 'two'))
    expect(store.tabs[0]).toBe(tab)
    expect(revision.value).toBe('two')
    expect(entry.value?.value).toEqual(note)
  })
  it('submits plain captured locations and never substitutes the current tab revision', async () => {
    setActivePinia(createPinia()); const store = useWorkspaceStore()
    store.applyDocument(wire(initial, 'latest'))
    const invoke = vi.fn(async input => {
      expect(input.baseRevision).toBe('captured')
      expect(isProxy(input)).toBe(false); expect(isProxy(input.sourceSpan)).toBe(false)
      return { ...wire(savedText, 'written'), changed: true }
    })
    vi.stubGlobal('window', { caretlex: { addVocabulary: invoke } })
    await store.addVocabulary(reactive({ documentId: 'doc', baseRevision: 'captured', sourceSpan: { start: 4, end: 8 }, selected: 'bank' }), 'bank', note)
    expect(invoke).toHaveBeenCalledOnce()
    expect(store.tabs[0].document.parsed.entries.get('bank')?.value).toEqual(note)
  })
})
