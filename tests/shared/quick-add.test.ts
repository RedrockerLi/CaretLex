import { describe, expect, it } from 'vitest'
import { buildQuickAddEntry, referenceInsertLength, shiftJobSpans, type QuickAddJob } from '../../src/shared/quick-add'
import { defaultSettings, parseSettings, renameProfile, type AppSettings, type ProviderProfile } from '../../src/shared/settings'
import { defaultResponse, llmPreset, llmType } from '../../src/shared/providers'
import type { ArticleData } from '../../src/shared/providers'
import type { EntryLocation, SourceResult } from '../../src/shared/bridge'
import type { VocabRecord } from '../../src/shared/types'

const profile = (name = 'ai_main'): ProviderProfile => ({ name, type: 'LLM', enabled: true, config: { ...llmType.defaultConfig() as object, baseUrl: 'https://example.com/v1', model: 'test' } })
const location: EntryLocation = { documentId: 'document', baseRevision: 'base', sourceSpan: { start: 4, end: 8 }, selected: 'went' }
const article: ArticleData = { original_word: 'went', original_sentence: 'She [went].' }
const settings: AppSettings = { ...defaultSettings, providers: [profile()], saveTemplate: llmPreset('ai_main') }
const response = (requestId: string, lemma = 'go'): SourceResult => ({
  requestId, article,
  sources: { article: { ...article }, ai_main: { ...defaultResponse as object, lemma, meaning_in_context: '去', english_definition: 'move', other_meanings: [] } },
  examples: { ai_main: defaultResponse, article: { original_word: '', original_sentence: '' } },
  issues: []
})
const job = (patch: Partial<QuickAddJob> = {}): QuickAddJob => ({ id: 'job', location, lemma: 'went', state: 'queued', usedSources: false, article, ...patch })

describe('quick add queue', () => {
  it('measures the reference marker that planAdd inserts', () => {
    expect(referenceInsertLength('bank')).toBe(9)
    expect(referenceInsertLength('go')).toBe(7)
  })

  it('shifts only the queued spans that follow the insertion point', () => {
    const before = job({ id: 'before', location: { ...location, sourceSpan: { start: 0, end: 3 } } })
    const saved = job({ id: 'saved' })
    const after = job({ id: 'after', location: { ...location, sourceSpan: { start: 40, end: 44 } } })
    const shifted = shiftJobSpans([before, saved, after], 'saved', 8, 9)
    expect(shifted.map(item => item.location.sourceSpan)).toEqual([{ start: 0, end: 3 }, { start: 4, end: 8 }, { start: 49, end: 53 }])
    expect(shifted[0]).toBe(before)
    expect(shifted[2]).not.toBe(after)
  })

  it('adopts the provider lemma suggestion and writes the fetched meaning once', () => {
    expect(buildQuickAddEntry(job({ result: response('one') }), settings, 'settings', new Map())).toEqual({
      ok: true,
      value: { lemma: 'go', usedSources: true, value: { lemma: 'go', contexts: [{ original_sentence: 'She [went].', meaning_in_context: '去', english_definition: 'move' }], other_meanings: [] } }
    })
  })

  it('falls back to the selected lowercase form with empty meanings when no result arrived', () => {
    expect(buildQuickAddEntry(job(), settings, 'settings', new Map())).toEqual({
      ok: true,
      value: { lemma: 'went', usedSources: false, value: { lemma: 'went', contexts: [{ original_sentence: 'She [went].', meaning_in_context: '', english_definition: '' }], other_meanings: [] } }
    })
  })

  it('keeps a bound lemma and only fills blank fields of the existing record', () => {
    const existing = { lemma: 'go', contexts: [{ original_sentence: 'She [went].', meaning_in_context: '人工释义', english_definition: '' }], other_meanings: [] }
    const record: VocabRecord = { lemma: 'go', value: existing, definitionSpan: { start: 0, end: 0 }, valueSpan: { start: 0, end: 0 }, referenceSpans: [], managed: true }
    expect(buildQuickAddEntry(job({ boundLemma: 'go', result: response('one', 'walk') }), settings, 'settings', new Map([['go', record]]))).toEqual({
      ok: true,
      value: { lemma: 'go', usedSources: true, value: { lemma: 'go', contexts: [{ original_sentence: 'She [went].', meaning_in_context: '人工释义', english_definition: 'move' }], other_meanings: [] } }
    })
  })

  it('ignores an unusable lemma suggestion and keeps the selected form', () => {
    const built = buildQuickAddEntry(job({ result: response('one', 'Go Home') }), settings, 'settings', new Map())
    expect(built).toMatchObject({ ok: true, value: { lemma: 'went', value: { lemma: 'went' } } })
  })
})

describe('quick add setting', () => {
  const base = { theme: 'light', providers: [], saveTemplate: defaultSettings.saveTemplate }
  it.each([[{ quickAdd: true }, true], [{ quickAdd: false }, false], [{}, false]])('parses %j as %s', (extra, expected) => {
    expect(parseSettings(JSON.stringify({ ...base, ...extra }))).toMatchObject({ ok: true, value: { quickAdd: expected } })
  })
  it('rejects a non-boolean value', () => {
    expect(parseSettings(JSON.stringify({ ...base, quickAdd: 'yes' }))).toMatchObject({ ok: false, error: { code: 'invalid-settings' } })
  })
  it('survives a provider rename', () => {
    const value: AppSettings = { ...defaultSettings, quickAdd: true, providers: [profile()], saveTemplate: llmPreset('ai_main') }
    expect(renameProfile(value, 'ai_main', 'ai_other').quickAdd).toBe(true)
  })
})
