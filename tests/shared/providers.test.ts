import { describe, expect, it } from 'vitest'
import { defaultSettings, parseSettings, renameProfile } from '../../src/shared/settings'
import { llmPreset, llmType, checkResponse, defaultDictionaryPrompt, defaultDictionaryResponse, defaultPrompt, defaultResponse, dictionaryPresetCompatibility, isDefaultSaveStructure, legacyDefaultPrompt, presetCompatibility, type ProviderType } from '../../src/shared/providers'
import { instantiateMapping, referencesSource, renameSource, validateMappingTemplate } from '../../src/shared/mapping'
import { locateContext, mergeEntry } from '../../src/shared/entries'
import { planAdd, planEdit } from '../../src/shared/patch'
import { parseDocument, mapVisibleRange } from '../../src/shared/protocol'
import { documentToWire, documentFromWire } from '../../src/shared/document-wire'
import { EntrySession } from '../../src/shared/entry-session'
import { extractArticle } from '../../src/main/article'
import type { JsonValue } from '../../src/shared/types'
import type { SourceResult } from '../../src/shared/bridge'

function selection(text: string, word: string, occurrence = 0) {
  const parsed = parseDocument(text)
  let seen = 0
  for (const run of parsed.textRuns) for (let from = 0; from < run.value.length; from++) {
    if (run.value.slice(from, from + word.length) !== word) continue
    const mapped = mapVisibleRange(parsed, run.sourceSpan, from, from + word.length)
    if (mapped.ok && seen++ === occurrence) return mapped
  }
  throw new Error('test word unavailable')
}
function article(text: string, word: string, occurrence = 0) { const selected = selection(text, word, occurrence); return extractArticle(text, selected.span, selected.selected) }
const profile = (name = 'ai_main', enabled = true) => ({ name, type: 'LLM', enabled, config: { ...llmType.defaultConfig() as object, baseUrl: 'https://example.com/v1', model: 'test' } })
const entry = (sentence: string, meaning = '义'): JsonValue => ({ lemma: 'bank', contexts: [{ original_sentence: sentence, meaning_in_context: meaning, english_definition: 'definition' }], other_meanings: [] })

describe('provider configuration and presets', () => {
  it('accepts same type with different names and permits all disabled', () => {
    const value = { ...defaultSettings, providers: [profile('ai_main'), profile('local_ai', false)] }
    expect(parseSettings(JSON.stringify(value))).toEqual({ ok: true, value })
    expect(parseSettings(JSON.stringify({ ...value, providers: value.providers.map(item => ({ ...item, enabled: false })) })).ok).toBe(true)
    expect(parseSettings(JSON.stringify({ ...defaultSettings, providers: [{ name: 'draft', type: 'LLM', enabled: false, config: llmType.defaultConfig() }] })).ok).toBe(true)
  })
  it.each([
    [profile('same'), profile('same', false)], [profile('article')], [profile('bad.name')], [profile('ai_main'), profile('local_ai')], [{ ...profile(), type: 'unknown' }], [{ ...profile(), config: { ...llmType.defaultConfig() as object, apiKey: 'must-not-be-here' } }]
  ])('rejects invalid instance configurations %j', (...providers) => { expect(parseSettings(JSON.stringify({ ...defaultSettings, providers })).ok).toBe(false) })
  it('enforces enabled URL/model, variables, timeout and uniform example structures', () => {
    expect(llmType.validateConfig(llmType.defaultConfig(), true).ok).toBe(false)
    for (const patch of [{ baseUrl: 'file:///tmp' }, { baseUrl: 'https://user:secret@example.com' }, { baseUrl: 'https://example.com/?secret=x' }, { model: '' }, { prompt: '{{bad}}' }, { prompt: '{{unfinished' }, { timeoutMs: 0 }, { timeoutMs: 1.2 }, { timeoutMs: 2147483648 }, { responseTemplate: [1, 'x'] }, { responseTemplate: [{ a: '' }, { b: '' }] }]) {
      expect(llmType.validateConfig({ ...profile().config, ...patch }, true).ok).toBe(false)
    }
  })
  it('keeps the JSON instruction inside the visible default prompt and upgrades untouched defaults only', () => {
    const base = { ...llmType.defaultConfig() as Record<string, JsonValue>, baseUrl: 'https://example.com/v1', model: 'test' }
    expect(defaultPrompt).toContain('Return only valid JSON')
    expect(defaultPrompt).toContain('{{JSON}}')
    expect(llmType.validateConfig(base, true)).toEqual({ ok: true, value: base })
    const legacy = { ...base, prompt: legacyDefaultPrompt }
    expect(llmType.validateConfig(legacy, true)).toEqual({ ok: true, value: base })
    expect(legacy.prompt).toBe(legacyDefaultPrompt)
    const edited = { ...base, prompt: 'Sentence: {{article.original_sentence}}' }
    expect(llmType.validateConfig(edited, true)).toEqual({ ok: true, value: edited })
  })
  it('creates the complete preset from an arbitrary case-sensitive name', () => {
    expect(llmPreset('Local_AI-2')).toEqual({ lemma: 'Local_AI-2.lemma', ipa: { $optional: 'Local_AI-2.ipa' }, audio: { $optional: 'Local_AI-2.audio' }, contexts: [{ original_sentence: 'article.original_sentence', meaning_in_context: 'Local_AI-2.meaning_in_context', english_definition: 'Local_AI-2.english_definition' }], other_meanings: [{ meaning: 'Local_AI-2.other_meanings[].meaning', english_definition: 'Local_AI-2.other_meanings[].english_definition', example_sentence: 'Local_AI-2.other_meanings[].example_sentence' }] })
    expect(presetCompatibility(profile().config)).toBeUndefined()
    expect(presetCompatibility({ ...profile().config, responseTemplate: { lemma: '' } })).toBeDefined()
    expect(presetCompatibility({ ...profile().config, responseTemplate: { ...defaultResponse as object, other_meanings: [] } })).toBeDefined()
    expect(isDefaultSaveStructure(defaultSettings.saveTemplate)).toBe(true)
    expect(isDefaultSaveStructure(llmPreset('ai_main'))).toBe(true)
    expect(isDefaultSaveStructure({ ...llmPreset('ai_main') as object, custom: '' })).toBe(false)
  })
  it('renames only explicit references and leaves literal data unchanged', () => {
    const value = { ...defaultSettings, providers: [profile()], saveTemplate: { lemma: 'ai_main.lemma', fixed: { $literal: ['ai_main.lemma'] }, text: 'prefix ai_main.lemma' } }
    expect(renameProfile(value, 'ai_main', 'new_name').saveTemplate).toEqual({ lemma: 'new_name.lemma', fixed: { $literal: ['ai_main.lemma'] }, text: 'prefix ai_main.lemma' })
    expect(parseSettings(JSON.stringify({ ...value, providers: [{ ...profile(), name: 'new_name' }] })).ok).toBe(true)
    expect(parseSettings(JSON.stringify(value))).toEqual({ ok: true, value }) // JSON never applies a preset.
  })
  it('validates a registered future type with the same profile interface', () => {
    const type: ProviderType = { type: 'test', defaultConfig: () => null, validateConfig: () => ({ ok: true, value: null }), createSavePreset: name => ({ field: `${name}.field` }) }
    expect(parseSettings(JSON.stringify({ ...defaultSettings, providers: [{ name: 'source', type: 'test', enabled: true, config: null }] }), new Map([['test', type]])).ok).toBe(true)
  })
})

describe('dictionary settings', () => {
  const enabled = { ...defaultSettings.dictionary, enabled: true }
  const llm = (patch: Record<string, JsonValue> = {}) => ({ ...profile(), config: { ...profile().config as Record<string, JsonValue>, ...patch } })
  it('normalizes a missing dictionary field for old settings files', () => {
    const legacy = { ...defaultSettings } as unknown as Record<string, JsonValue>
    delete legacy.dictionary
    const parsed = parseSettings(JSON.stringify(legacy))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.dictionary).toEqual(defaultSettings.dictionary)
  })
  it.each([
    null, [], { enabled: 'yes' }, { timeoutMs: 0 }, { timeoutMs: 1.2 }, { timeoutMs: 2147483648 },
    { apiKeyRef: 'bad' }, { unknown: true }, { responseTemplate: [] }, { responseTemplate: { lemma: '' } }
  ])('rejects an invalid dictionary object %j', dictionary => {
    expect(parseSettings(JSON.stringify({ ...defaultSettings, dictionary })).ok).toBe(false)
  })
  it('accepts an enabled dictionary with a compatible prompt and response template', () => {
    const value = { ...defaultSettings, providers: [llm({ prompt: defaultDictionaryPrompt })], dictionary: enabled, saveTemplate: llmPreset('ai_main') }
    const parsed = parseSettings(JSON.stringify(value))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect((parsed.value.providers[0].config as Record<string, JsonValue>).prompt).toBe(defaultDictionaryPrompt)
  })
  it('upgrades the untouched default prompt when the dictionary is enabled', () => {
    const parsed = parseSettings(JSON.stringify({ ...defaultSettings, providers: [llm()], dictionary: enabled }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect((parsed.value.providers[0].config as Record<string, JsonValue>).prompt).toBe(defaultDictionaryPrompt)
  })
  it('restores the normal default prompt when the dictionary is disabled', () => {
    const parsed = parseSettings(JSON.stringify({ ...defaultSettings, providers: [llm({ prompt: defaultDictionaryPrompt })] }))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect((parsed.value.providers[0].config as Record<string, JsonValue>).prompt).toBe(defaultPrompt)
  })
  it('rejects a custom prompt without the dictionary variable when enabled', () => {
    expect(parseSettings(JSON.stringify({ ...defaultSettings, providers: [llm({ prompt: 'Write JSON: {{JSON}}' })], dictionary: enabled })))
      .toMatchObject({ ok: false, error: { code: 'dictionary-prompt-missing' } })
  })
  it('rejects a response template that cannot feed the default save mapping', () => {
    expect(parseSettings(JSON.stringify({ ...defaultSettings, providers: [llm({ prompt: defaultDictionaryPrompt, responseTemplate: { lemma: '' } })], dictionary: enabled })))
      .toMatchObject({ ok: false, error: { code: 'dictionary-response-template-incompatible' } })
  })
  it('rejects a custom prompt with the dictionary variable when disabled', () => {
    expect(parseSettings(JSON.stringify({ ...defaultSettings, providers: [llm({ prompt: 'Custom {{dictionary}} {{JSON}}' })] })))
      .toMatchObject({ ok: false, error: { code: 'dictionary-prompt-unexpected' } })
  })
  it('validates the enriched response example shape', () => {
    const example = defaultDictionaryResponse as Record<string, JsonValue>
    expect(dictionaryPresetCompatibility(defaultDictionaryResponse)).toBeUndefined()
    expect(dictionaryPresetCompatibility({ ...example, extra: '' })).toBeUndefined()
    expect(dictionaryPresetCompatibility({ lemma: '' })).toBeDefined()
    expect(dictionaryPresetCompatibility({ ...example, other_meanings: [] })).toBeDefined()
  })
})

describe('article extraction and explicit English boundaries', () => {
  it.each([
    ['Dr. Smith met Mr. Brown. They left.', 'Smith', 'Dr. [Smith] met Mr. Brown.'],
    ['Use e.g. Apples or Pears. Try bananas.', 'Apples', 'Use e.g. [Apples] or Pears.'],
    ['He lives in the U.S. He returned.', 'returned', 'He [returned].'],
    ['The value is 3.14. It changed.', 'changed', 'It [changed].'],
    ['She asked, “Why?” Then she left.', 'Why', 'She asked, “[Why]?”'],
    ['“Run!” he said. Then he left.', 'Run', '“[Run]!” he said.'],
    ['He waited… Then he left.', 'left', 'Then he [left].'],
    ['He waited... Then he left.', 'left', 'Then he [left].'],
    ['He waited… and then left.', 'left', 'He waited… and then [left].'],
    ['He said “One. Two.” Then left.', 'Two', '[Two].”'],
    ['He said “One. Two.” Then left.', 'left', 'Then [left].'],
    ['# Dr. Smith left.', 'Smith', 'Dr. [Smith] left.'],
    ['| A | B |\n| --- | --- |\n| He left. | She ran. |', 'left', 'He [left].'],
    ['😀 &amp; **Bank** can\\\'t c&#97;t.', 'cat', "😀 & Bank can't [cat]."],
    ['She\nwent home.', 'went', 'She\n[went] home.'],
    ['She  \nwent home.', 'went', '[went] home.'],
    ['She\\\nwent home.', 'went', '[went] home.'],
    ['She\r\nwent home.\r\n\r\nThen left.', 'went', 'She\r\n[went] home.'],
    ['She [left] today.', 'left', 'She [[left]] today.']
  ])('preserves %s', (text, word, expected) => { expect(article(text, word)).toEqual({ ok: true, value: { original_word: word, original_sentence: expected } }) })
  it('marks only the actual second and third occurrences and ignores references', () => {
    const text = 'The bank is beside the river bank and another bank.'
    expect(article(text, 'bank', 1)).toMatchObject({ value: { original_sentence: 'The bank is beside the river [bank] and another bank.' } })
    expect(article(text, 'bank', 2)).toMatchObject({ value: { original_sentence: 'The bank is beside the river bank and another [bank].' } })
    const added = planAdd(text, { ...selection(text, 'bank'), span: selection(text, 'bank').span, lemma: 'bank', value: entry('original') })
    if (!added.ok) throw new Error('patch failure')
    expect(article(added.value.text, 'bank', 1)).toMatchObject({ value: { original_sentence: 'The bank is beside the river [bank] and another bank.' } })
  })
  it('fails explicitly for invalid selections and unextractable raw HTML', () => {
    expect(extractArticle('word', { start: 1, end: 4 }, 'word').ok).toBe(false)
    expect(article('Some <b>word</b> here.', 'word').ok).toBe(false)
  })
})

function mapped(template: JsonValue, values: Record<string, JsonValue>, examples?: Record<string, JsonValue>) {
  const result = instantiateMapping(template, { values, examples })
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
describe('source mappings and JSON values', () => {
  const article = { original_word: 'went', original_sentence: 'She [went].' }
  it('copies exact scalar and subtree values and does not reevaluate provider data', () => {
    const result = mapped({ number: 'p.n', bool: 'p.b', nil: 'p.nil', subtree: 'p.obj', literal: { $literal: { value: 'p.n' } }, text: 'hello', fixed: 'p.rows[1].name' }, { p: { n: 12, b: false, nil: null, obj: { key: 'article.original_sentence' }, rows: [{ name: 'a' }, { name: 'b' }] } })
    expect(result.value).toEqual({ number: 12, bool: false, nil: null, subtree: { key: 'article.original_sentence' }, literal: { value: 'p.n' }, text: 'hello', fixed: 'b' })
    expect(result.issues).toEqual([])
  })
  it.each([0, 1, 4])('uses actual array length %i and broadcasts article values', count => {
    const rows = Array.from({ length: count }, (_, i) => ({ name: `n${i}`, n: i }))
    expect(mapped([{ name: 'p.rows[].name', n: 'p.rows[].n', word: 'article.original_word' }], { p: { rows }, article }).value).toEqual(rows.map(row => ({ ...row, word: 'went' })))
  })
  it('keeps partial rows, distinguishes null/empty/missing, and blocks invalid whole subtrees', () => {
    const result = mapped({ rows: [{ name: 'p.rows[].name', n: 'p.rows[].n' }], obj: 'p.obj', nil: 'p.nil', empty: 'p.empty', absent: 'p.absent', unavailable: [{ name: 'gone.rows[].name' }] }, {
      p: { rows: [{ name: 'a', n: 1 }, { name: 2, n: 2 }, { n: null }], obj: { text: 5 }, nil: null, empty: [] }
    }, { p: { rows: [{ name: '', n: 0 }], obj: { text: '' }, nil: null, empty: [], absent: false } })
    expect(result.value).toEqual({ rows: [{ name: 'a', n: 1 }, { name: '', n: 2 }, { name: '', n: null }], obj: null, nil: null, empty: [], absent: null, unavailable: [] })
    expect(result.issues.length).toBe(6)
  })
  it('resolves $optional silently when the source field is missing, empty or unusable', () => {
    const template = { ipa: { $optional: 'p.ipa' }, audio: { $optional: 'p.audio' }, empty: { $optional: 'p.empty' }, wrong: { $optional: 'p.wrong' }, absent: { $optional: 'p.absent' } }
    const present = mapped(template, { p: { ipa: 'ˈgoʊ', audio: 'https://example.test/a.mp3', empty: '   ', wrong: 12 } })
    expect(present.value).toEqual({ ipa: 'ˈgoʊ', audio: 'https://example.test/a.mp3', empty: '', wrong: '', absent: '' })
    expect(present.issues).toEqual([])
    expect(mapped({ x: { $optional: 'gone.field' } }, {}).issues).toEqual([])
  })
  it('validates and renames $optional references', () => {
    expect(validateMappingTemplate({ x: { $optional: 'p.field' } }).ok).toBe(true)
    expect(validateMappingTemplate({ x: { $optional: 'p.field' } }).ok && mapped({ x: { $optional: 'p.field' } }, { p: { field: 'v' } }).value).toEqual({ x: 'v' })
    expect(validateMappingTemplate({ x: { $optional: 'nope' } }).ok).toBe(false)
    expect(validateMappingTemplate({ x: { $optional: 12 } }).ok).toBe(false)
    expect(referencesSource({ x: { $optional: 'p.field' } }, 'p')).toBe(true)
    expect(referencesSource({ x: { $optional: 'p.field' } }, 'q')).toBe(false)
    expect(renameSource({ x: { $optional: 'p.field' } }, 'p', 'q')).toEqual({ x: { $optional: 'q.field' } })
  })
  it('supports nested arrays at explicit layers and independent fixed arrays', () => {
    expect(mapped([{ name: 'p.rows[].name', children: [{ value: 'p.rows[].children[].value' }] }], { p: { rows: [{ name: 'one', children: [{ value: 1 }, { value: 2 }] }, { name: 'two', children: [] }] } }).value).toEqual([{ name: 'one', children: [{ value: 1 }, { value: 2 }] }, { name: 'two', children: [] }])
    expect(mapped(['p.value', false, 0, null], { p: { value: 'x' } }).value).toEqual(['x', false, 0, null])
  })
  it.each([
    [{ a: 'p.a[].x', b: 'p.b[].x' }], [{ a: 'p.a[].x' }, { a: 'p.a[].x' }], [{ a: 'p.a[].children[].x' }], { a: 'p.a[].x' }
  ])('rejects ambiguous expansion %j', template => { expect(validateMappingTemplate(template).ok).toBe(false) })
  it('does not persist unresolved references or execute literal references', () => {
    expect(mapped({ str: 'missing.text', num: 'missing.n' }, {}, { missing: { text: '', n: 0 } }).value).toEqual({ str: '', num: null })
    expect(referencesSource({ $literal: 'p.field' }, 'p')).toBe(false)
    expect(referencesSource([{ x: 'p.field' }], 'p')).toBe(true)
    expect(validateMappingTemplate({ x: 'p.rows[bad]' }).ok).toBe(false)
    expect(validateMappingTemplate({ x: Infinity }).ok).toBe(false)
  })
  it('checks every row against examples and permits additional fields and arbitrary lengths', () => {
    expect(checkResponse({ lemma: 'go', meaning_in_context: '义', english_definition: 'd', other_meanings: [], extra: 2 }, defaultResponse)).toEqual([])
    expect(checkResponse({ lemma: 2, other_meanings: [{ meaning: 'x' }, { meaning: 'y', english_definition: false }] }, defaultResponse)).toHaveLength(7)
  })
})

describe('context merging, identity and final writes', () => {
  it('appends exact marker keys, preserving old context, other meanings and custom root fields', () => {
    const existing = { ...entry('The [bank] is by the bank.', 'user edit') as object, other_meanings: [{ meaning: 'old' }], custom: 23 }
    const result = mergeEntry(existing, entry('The bank is by the [bank].'))
    expect(result).toMatchObject({ ok: true, value: { custom: 23, other_meanings: [{ meaning: 'old' }], contexts: [expect.objectContaining({ meaning_in_context: 'user edit' }), expect.objectContaining({ original_sentence: 'The bank is by the [bank].' })] } })
    expect(mergeEntry(existing, entry('The [bank] is by the bank.', 'overwrite'))).toEqual({ ok: true, value: existing })
    expect(mergeEntry({ translation: 'old' }, entry('sentence')).ok).toBe(false)
  })
  it('fills blank context fields from the new value and keeps written wording', () => {
    const blank = { lemma: 'bank', contexts: [{ original_sentence: 'The [bank].', meaning_in_context: '', english_definition: '' }], other_meanings: [] }
    expect(mergeEntry(blank, entry('The [bank].', '（名词）银行'))).toEqual({ ok: true, value: { lemma: 'bank', contexts: [{ original_sentence: 'The [bank].', meaning_in_context: '（名词）银行', english_definition: 'definition' }], other_meanings: [] } })
    expect(mergeEntry(entry('The [bank].', '人工释义'), entry('The [bank].', '新释义'))).toEqual({ ok: true, value: entry('The [bank].', '人工释义') })
  })
  it('locates exactly one context and reports changed, duplicated and unrecognized sentences', () => {
    expect(locateContext(entry('one'), 'one').context?.meaning_in_context).toBe('义')
    expect(locateContext(entry('one'), 'two').message).toContain('没有匹配')
    expect(locateContext({ lemma: 'bank', contexts: [ ...(entry('one') as Record<string, JsonValue>).contexts as JsonValue[], ...(entry('one') as Record<string, JsonValue>).contexts as JsonValue[] ], other_meanings: [] }, 'one').message).toContain('多个')
    expect(locateContext(null, 'one').message).toContain('无法识别')
  })
  it('rejects stacked identities across formatting delimiters and ordinary notes', () => {
    for (const text of ['**bank**[^w-bank]', 'bank[^1][^w-bank]']) {
      const source = text + '\n\n[^1]: ordinary\n\n<!-- caretlex:vocab:start -->\n[^w-bank]: ' + JSON.stringify(entry('old')) + '\n<!-- caretlex:vocab:end -->\n'
      const selected = selection(source, 'bank')
      expect(planAdd(source, { span: selected.span, selected: 'bank', lemma: 'other', value: { lemma: 'other' } }).ok).toBe(false)
      const updated = planAdd(source, { span: selected.span, selected: 'bank', lemma: 'bank', value: entry('new') })
      expect(updated).toMatchObject({ ok: true, value: { text: expect.stringContaining(text) } })
    }
  })
  it('writes complete edited values at the same reference and rejects lemma changes/deletion', () => {
    const text = '\uFEFFThe bank. Another bank.\r\n'
    const firstSelection = selection(text, 'bank')
    const first = planAdd(text, { span: firstSelection.span, selected: 'bank', lemma: 'bank', value: entry('one') })
    if (!first.ok) throw new Error('first failed')
    const value = { ...entry('one', 'hand edit') as object, extra: false }
    const same = planAdd(first.value.text, { span: firstSelection.span, selected: 'bank', lemma: 'bank', value })
    if (!same.ok) throw new Error('same failed')
    expect(same.value.text).toContain('"meaning_in_context":"hand edit"')
    expect(same.value.text).toContain('"extra":false')
    expect(same.value.text.match(/bank\[\^w-bank\]/g)).toHaveLength(1)
    expect(planAdd(same.value.text, { span: firstSelection.span, selected: 'bank', lemma: 'bank', value })).toMatchObject({ value: { changed: false, patches: [] } })
    expect(planEdit(same.value.text, { lemma: 'bank', value: { ...value, lemma: 'other' } }).ok).toBe(false)
    expect(planEdit(same.value.text, { lemma: 'bank', value: { contexts: [], other_meanings: [] } }).ok).toBe(false)
    expect(planEdit(same.value.text, { lemma: 'bank', value: null }).ok).toBe(false)
    expect(same.value.text.startsWith('\uFEFFThe bank[^w-bank]. Another bank.\r\n')).toBe(true)
    expect(planEdit(same.value.text, { lemma: 'bank', value: { ...value, huge: 'x'.repeat(1024 * 1024) } }).ok).toBe(false)
  })
})

describe('entry session and asynchronous draft protection', () => {
  const location = { documentId: 'document', baseRevision: 'base', sourceSpan: { start: 0, end: 4 }, selected: 'went' }
  const settings = { ...defaultSettings, providers: [profile()], saveTemplate: llmPreset('ai_main') }
  const response = (requestId: string, lemma = 'go'): SourceResult => ({ requestId, article: { original_word: 'went', original_sentence: 'She [went].' }, sources: { article: { original_word: 'went', original_sentence: 'She [went].' }, ai_main: { ...defaultResponse as object, lemma, meaning_in_context: '去', english_definition: 'move', other_meanings: [] } }, examples: { ai_main: defaultResponse, article: { original_word: '', original_sentence: '' } }, issues: [] })
  it('supports manual saving independently of failed mapping or provider', () => {
    const session = new EntrySession(location, { ...defaultSettings, saveTemplate: [{ value: 'p.a[].children[].x' }] }, 'settings', new Map())
    session.setLemma('go'); session.edit(JSON.stringify({ lemma: 'go', contexts: [], other_meanings: [] }))
    expect(session.parse().ok).toBe(true); expect(session.confirm()).toBe(true); expect(session.locked).toBe(true)
    session.saving = false; session.setLemma('other'); expect(session.lemma).toBe('go')
  })
  it('does not claim an automatic lemma when only local article data is refreshed', () => {
    const session = new EntrySession(location, defaultSettings, 'settings', new Map())
    const article = { original_word: 'went', original_sentence: 'She [went].' }
    session.startRequest('local')
    session.receive({ requestId: 'local', article, sources: { article: { ...article } }, examples: {}, issues: [] })
    expect(session.lemma).toBe('went')
    expect(session.issues.some(issue => issue.code === 'invalid-lemma-suggestion')).toBe(false)
    expect(JSON.parse(session.text).contexts[0].original_sentence).toBe(article.original_sentence)
  })
  it('applies untouched auto results and protects edited drafts from late results and retries', () => {
    const session = new EntrySession(location, settings, 'settings', new Map())
    session.startRequest('one'); expect(session.receive(response('one'))).toBe(true); expect(session.lemma).toBe('go')
    session.edit(JSON.stringify({ lemma: 'go', contexts: [], other_meanings: [], hand: true })); const text = session.text
    session.startRequest('two'); session.receive(response('two', 'leave'))
    expect(session.text).toBe(text); expect(session.lemma).toBe('go'); expect(session.pending?.lemma).toBe('leave')
    session.applyPending(); expect(session.lemma).toBe('leave'); expect(session.touched).toBe(true)
    session.startRequest('three'); const applied = session.text; session.receive(response('three')); expect(session.text).toBe(applied); expect(session.pending).toBeDefined()
  })
  it('ignores old IDs, keeps failure text and invalidates without discarding drafts', () => {
    const session = new EntrySession(location, settings, 'settings', new Map()); session.edit('{unfinished'); const text = session.text
    session.startRequest('new'); expect(session.receive(response('old'))).toBe(false)
    session.requestFailed('new', 'timeout'); expect(session.text).toBe(text)
    session.startRequest('another'); session.replaceSettings(defaultSettings, 'newsettings'); expect(session.receive(response('another'))).toBe(false)
    session.invalidate('external change'); expect(session.text).toBe(text); expect(session.confirm()).toBe(false)
  })
  it('rebuilds for a new target without carrying contexts of the old target', () => {
    const old = { lemma: 'go', contexts: [{ original_sentence: 'old-go', meaning_in_context: 'old', english_definition: '' }], other_meanings: [] }
    const session = new EntrySession(location, settings, 'settings', new Map([['go', { lemma: 'go', value: old, managed: true, definitionSpan: { start: 0, end: 1 }, valueSpan: { start: 0, end: 1 }, referenceSpans: [] }]]))
    session.startRequest('one'); session.receive(response('one')); expect(session.text).toContain('old-go')
    session.setLemma('leave'); expect(session.text).not.toContain('old-go')
  })
})

describe('document IPC serialization', () => {
  it('round-trips the real entry index through plain data before merging', () => {
    const text = 'bank[^w-bank]\n\n<!-- caretlex:vocab:start -->\n[^w-bank]: ' + JSON.stringify(entry('old')) + '\n<!-- caretlex:vocab:end -->\n'
    const parsed = parseDocument(text)
    const local = { parsed, snapshot: { id: 'document', text, bom: false, eol: '\n' as const } }
    const wire = documentToWire(local)
    expect(Array.isArray(wire.parsed.entries)).toBe(true)
    const restored = documentFromWire(JSON.parse(JSON.stringify(wire)))
    expect(restored.parsed.entries.get('bank')?.value).toEqual(entry('old'))
    expect(mergeEntry(restored.parsed.entries.get('bank')!.value, entry('new'))).toMatchObject({ value: { contexts: [expect.any(Object), expect.any(Object)] } })
  })
})
