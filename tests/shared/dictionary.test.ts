import { describe, expect, it } from 'vitest'
import {
  assembleEnrichedEntry, buildDictionaryReference, cleanDictionaryText, isPronunciationUrl,
  normalizeLearnersResponse, pronunciationUrl, type DictionaryLookup
} from '../../src/shared/dictionary'

function entry(
  id: string,
  hw: string,
  fl: string,
  stems: string[],
  senses: Array<[string, string[]?]> = [],
  options: { shortdef?: string[]; ipa?: string } = {}
): Record<string, unknown> {
  return {
    meta: { id, stems },
    hwi: { hw, prs: [{ ipa: options.ipa ?? '/test/', sound: { audio: 'test001' } }] },
    ...(fl ? { fl } : {}),
    ...(senses.length ? {
      def: [{
        sseq: [senses.map(([definition, examples]) => ['sense', {
          dt: [
            ['text', definition],
            ...(examples?.length ? [['vis', examples.map(t => ({ t }))]] : [])
          ]
        }])]
      }]
    } : {}),
    ...(options.shortdef ? { shortdef: options.shortdef } : {})
  }
}

const wentFixture = [
  entry('went', 'went', '', ['went', 'go']),
  entry('go:1', 'go', 'verb', ['go', 'goes', 'going', 'gone', 'went'], [
    ['{bc}to move or travel to a place', ['We {it}went{/it} home.']],
    ['{bc}to leave a place', ['She {it}went{/it} away.']]
  ]),
  entry('unnoticed', 'unnoticed', 'adjective', ['unnoticed', 'went'], [['not seen or noticed']]),
  entry('air', 'air', 'noun', ['air', 'went off the air'], [['the invisible mixture of gases']])
]

const childrenFixture = [
  entry('children', 'children', '', ['children']),
  entry('child', 'child', 'noun', ['child', 'children'], [['a young person', ['The {it}children{/it} played.']]]),
  entry('bed', 'bed', 'noun', ['bed', 'put the children to bed'], [['a piece of furniture']]),
  entry('flower child', 'flower child', 'noun', ['flower child', 'flower children'], [['a hippie']])
]

const runningFixture = [
  entry('running:1', 'running', 'noun', ['running'], [['the activity of running']]),
  entry('running:2', 'running', 'adjective', ['running'], [['operating or flowing']]),
  entry('run:1', 'run', 'verb', ['run', 'ran', 'running', 'runs'], [['to move swiftly', ['She {it}ran{/it}.']]]),
  entry('running back', 'running back', 'noun', ['running back', 'running backs'], [['a football player']])
]

const betterFixture = [
  entry('better:1', 'better', 'adjective', ['better'], [['higher in quality']]),
  entry('good:1', 'good', 'adjective', ['good', 'better', 'best'], [['of high quality']]),
  entry('well:1', 'well', 'adverb', ['well', 'better', 'best'], [['in a good way']]),
  entry('better half', 'better half', 'noun', ['better half', 'better halves'], [['spouse']])
]

describe('normalizeLearnersResponse', () => {
  it('follows a redirect stub and drops stem noise', () => {
    const lookup = normalizeLearnersResponse('went', wentFixture)
    expect(lookup.candidates).toHaveLength(1)
    expect(lookup.candidates[0]).toMatchObject({ entryId: 'go:1', lemma: 'go', partOfSpeech: 'verb', ipa: '/test/' })
    expect(lookup.candidates[0].senses.map(sense => sense.id)).toEqual(['go:1#0', 'go:1#1'])
    expect(lookup.candidates[0].senses[0]).toEqual({
      id: 'go:1#0', definition: 'to move or travel to a place', examples: ['We went home.']
    })
  })

  it('selects a stem-matched lemma when the stub has no second stem', () => {
    const lookup = normalizeLearnersResponse('children', childrenFixture)
    expect(lookup.candidates.map(candidate => candidate.lemma)).toEqual(['child'])
    expect(lookup.candidates[0].senses[0].definition).toBe('a young person')
  })

  it('keeps direct headwords and a stem-matched base form, stopping at phrases', () => {
    const lookup = normalizeLearnersResponse('running', runningFixture)
    expect(lookup.candidates.map(candidate => candidate.lemma)).toEqual(['running', 'running', 'run'])
  })

  it('keeps homographs and at most one stem-matched fallback', () => {
    const lookup = normalizeLearnersResponse('better', betterFixture)
    expect(lookup.candidates.map(candidate => candidate.lemma)).toEqual(['better', 'good'])
  })

  it('falls back to shortdef when def senses are absent', () => {
    const lookup = normalizeLearnersResponse("don't", [
      entry("don't:1", "don't", '', ["don't"], [], { shortdef: ['—used as a contraction of do not'] })
    ])
    expect(lookup.candidates).toHaveLength(1)
    expect(lookup.candidates[0].senses[0]).toEqual({
      id: "don't:1#s0", definition: '—used as a contraction of do not', examples: []
    })
  })

  it('returns an empty candidate list for suggestions or non-array responses', () => {
    expect(normalizeLearnersResponse('gooo', ['goo', 'go']).candidates).toEqual([])
    expect(normalizeLearnersResponse('gooo', null).candidates).toEqual([])
  })

  it('carries the pronunciation audio file name and drops unusable ones', () => {
    expect(normalizeLearnersResponse('went', wentFixture).candidates[0].audio).toBe('test001')
    const raw = (audio: unknown) => [{
      meta: { id: 'go:1', stems: ['go'] },
      hwi: { hw: 'go', prs: [{ ipa: 'goʊ', ...(audio === undefined ? {} : { sound: { audio } }) }] },
      def: [{ sseq: [[['sense', { dt: [['text', 'to move']] }]]] }]
    }]
    expect(normalizeLearnersResponse('go', raw(undefined)).candidates[0].audio).toBeUndefined()
    expect(normalizeLearnersResponse('go', raw('bad/id')).candidates[0].audio).toBeUndefined()
  })
})

describe('pronunciationUrl', () => {
  const base = 'https://media.merriam-webster.com/audio/prons/en/us/mp3'
  it('applies the Merriam-Webster subdirectory rules', () => {
    expect(pronunciationUrl('apple001')).toBe(`${base}/a/apple001.mp3`)
    expect(pronunciationUrl('bix001')).toBe(`${base}/bix/bix001.mp3`)
    expect(pronunciationUrl('gg001')).toBe(`${base}/gg/gg001.mp3`)
    expect(pronunciationUrl('3d000001')).toBe(`${base}/number/3d000001.mp3`)
    expect(pronunciationUrl('_x1')).toBe(`${base}/number/_x1.mp3`)
    expect(pronunciationUrl('go:1')).toBeUndefined()
    expect(pronunciationUrl('')).toBeUndefined()
  })

  it('only accepts exact Merriam-Webster media addresses', () => {
    expect(isPronunciationUrl(`${base}/a/apple001.mp3`)).toBe(true)
    expect(isPronunciationUrl(`${base}/A/apple001.mp3`)).toBe(false)
    expect(isPronunciationUrl(`${base}/a/../../secret.mp3`)).toBe(false)
    expect(isPronunciationUrl(`${base}/a/apple001.mp3?key=x`)).toBe(false)
    expect(isPronunciationUrl('https://evil.test/audio/prons/en/us/mp3/a/apple001.mp3')).toBe(false)
    expect(isPronunciationUrl('http://media.merriam-webster.com/audio/prons/en/us/mp3/a/apple001.mp3')).toBe(false)
  })
})

describe('cleanDictionaryText', () => {
  it('removes dictionary markup, leading colon and extra whitespace', () => {
    expect(cleanDictionaryText('{bc}  sad,   {it}unhappy{/it} : not happy ')).toBe('sad, unhappy: not happy')
    expect(cleanDictionaryText('{bc}plain definition')).toBe('plain definition')
  })
})

describe('buildDictionaryReference', () => {
  it('caps the reference size by trimming candidates and senses', () => {
    const candidates = Array.from({ length: 10 }, (_, candidateIndex) => ({
      entryId: `e:${candidateIndex}`,
      lemma: `word${candidateIndex}`,
      partOfSpeech: 'noun',
      senses: Array.from({ length: 6 }, (_, senseIndex) => ({
        id: `e:${candidateIndex}#${senseIndex}`,
        definition: 'x'.repeat(400),
        examples: ['y'.repeat(300)]
      }))
    }))
    const lookup: DictionaryLookup = { query: 'word', candidates, fetchedAt: 0 }
    const reference = buildDictionaryReference(lookup, 'word')
    expect(JSON.stringify(reference).length).toBeLessThanOrEqual(32 * 1024)
    expect((reference as { available: boolean }).available).toBe(true)
  })

  it('marks an empty lookup as unavailable', () => {
    const reference = buildDictionaryReference({ query: 'word', candidates: [], fetchedAt: 0 }, 'word')
    expect(reference).toMatchObject({ available: false, word: 'word' })
  })

  it('never sends pronunciation data to the LLM', () => {
    const serialized = JSON.stringify(buildDictionaryReference(normalizeLearnersResponse('went', wentFixture), 'went'))
    expect(serialized).not.toContain('test001')
    expect(serialized).not.toContain('/test/')
  })
})

describe('assembleEnrichedEntry', () => {
  const lookup = normalizeLearnersResponse('went', wentFixture)

  it('uses dictionary definitions for valid sense IDs', () => {
    const result = assembleEnrichedEntry({
      lemma: 'go',
      context_sense_id: 'go:1#0',
      meaning_in_context: '（动词）去',
      english_definition: '',
      other_meanings: [{
        sense_id: 'go:1#1', meaning: '（动词）离开', english_definition: '', example_sentence: 'She went home.'
      }]
    }, lookup)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      lemma: 'go',
      meaning_in_context: '（动词）去',
      english_definition: 'to move or travel to a place',
      other_meanings: [{
        meaning: '（动词）离开',
        english_definition: 'to leave a place',
        example_sentence: 'She went home.'
      }]
    })
  })

  it('falls back to the LLM definition when the context sense is invalid', () => {
    const result = assembleEnrichedEntry({
      lemma: 'go', context_sense_id: 'missing', meaning_in_context: '去',
      english_definition: 'LLM definition', other_meanings: []
    }, lookup)
    expect(result.ok && result.value).toMatchObject({ english_definition: 'LLM definition' })
    if (result.ok) expect(result.value.english_definition).toBe('LLM definition')
  })

  it('uses the first sense when both the sense ID and LLM definition are unavailable', () => {
    const result = assembleEnrichedEntry({
      lemma: 'go', context_sense_id: 'missing', meaning_in_context: '去',
      english_definition: '', other_meanings: []
    }, lookup)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.english_definition).toBe('to move or travel to a place')
  })

  it('corrects a lemma that does not match the context sense', () => {
    const ambiguous = normalizeLearnersResponse('better', betterFixture)
    const result = assembleEnrichedEntry({
      lemma: 'better', context_sense_id: 'good:1#0', meaning_in_context: '更好',
      english_definition: '', other_meanings: []
    }, ambiguous)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lemma).toBe('good')
    expect(result.issues.some(issue => issue.code === 'dictionary-lemma-mismatch')).toBe(true)
  })

  it('ignores other meanings from a different lemma and keeps the LLM fallback definition', () => {
    const ambiguous = normalizeLearnersResponse('better', betterFixture)
    const result = assembleEnrichedEntry({
      lemma: 'better', context_sense_id: 'better:1#0', meaning_in_context: '更好',
      english_definition: '',
      other_meanings: [{ sense_id: 'good:1#0', meaning: '好', english_definition: 'LLM fallback', example_sentence: 'It is good.' }]
    }, ambiguous)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.other_meanings).toEqual([{ meaning: '好', english_definition: 'LLM fallback', example_sentence: 'It is good.' }])
    expect(result.issues.some(issue => issue.code === 'dictionary-sense-mismatch')).toBe(true)
  })

  it('uses LLM fields when no dictionary lookup is available', () => {
    const result = assembleEnrichedEntry({
      lemma: 'go', context_sense_id: '', meaning_in_context: '去',
      english_definition: 'LLM definition',
      other_meanings: [{ sense_id: '', meaning: '离开', english_definition: 'LLM other', example_sentence: 'She went home.' }]
    }, undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      lemma: 'go',
      english_definition: 'LLM definition',
      other_meanings: [{ meaning: '离开', english_definition: 'LLM other', example_sentence: 'She went home.' }]
    })
  })

  it('caps other meanings and long text fields', () => {
    const result = assembleEnrichedEntry({
      lemma: 'go', context_sense_id: 'go:1#0', meaning_in_context: 'x'.repeat(5000),
      english_definition: '',
      other_meanings: Array.from({ length: 20 }, (_, index) => ({
        sense_id: '', meaning: `m${index}`, english_definition: `d${index}`, example_sentence: `e${index}`
      }))
    }, lookup)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value.meaning_in_context as string).length).toBe(2000)
    expect(result.value.other_meanings).toHaveLength(8)
  })

  it('writes the pronunciation fields of the matched candidate', () => {
    const result = assembleEnrichedEntry({
      lemma: 'go', context_sense_id: 'go:1#0', meaning_in_context: '去',
      english_definition: '', other_meanings: []
    }, lookup)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ipa).toBe('/test/')
    expect(result.value.audio).toBe('https://media.merriam-webster.com/audio/prons/en/us/mp3/t/test001.mp3')
  })

  it('leaves pronunciation fields empty without a lookup', () => {
    const result = assembleEnrichedEntry({
      lemma: 'go', context_sense_id: '', meaning_in_context: '去',
      english_definition: 'LLM definition', other_meanings: []
    }, undefined)
    expect(result.ok && result.value).toMatchObject({ ipa: '', audio: '' })
  })

  it('rejects a non-object LLM response', () => {
    expect(assembleEnrichedEntry([], undefined)).toMatchObject({ ok: false, error: { code: 'dictionary-invalid-llm' } })
  })
})
