import { describe, expect, it } from 'vitest'
import { exportVocabulary, planAdd, planDelete, planEdit } from '../../src/shared/patch'
import { mapVisibleRange, parseDocument, validateSelection } from '../../src/shared/protocol'
import { defaultSettings, instantiateTemplate, parseSettings } from '../../src/shared/settings'
import type { JsonValue, TextRun } from '../../src/shared/types'

const START = '<!-- caretlex:vocab:start -->'
const END = '<!-- caretlex:vocab:end -->'

function mappedWord(text: string, visibleWord: string, occurrence = 0) {
  const parsed = parseDocument(text)
  const candidates: Array<{ run: TextRun; index: number }> = []
  for (const run of parsed.textRuns) {
    let from = 0
    while (from <= run.value.length - visibleWord.length) {
      const index = run.value.indexOf(visibleWord, from)
      if (index < 0) break
      candidates.push({ run, index })
      from = index + 1
    }
  }
  const candidate = candidates[occurrence]
  if (!candidate) throw new Error(`No visible occurrence of ${visibleWord}`)
  const mapped = mapVisibleRange(parsed, candidate.run.sourceSpan, candidate.index, candidate.index + visibleWord.length)
  if (!mapped.ok) throw new Error(mapped.reason)
  return { parsed, ...mapped }
}

function add(text: string, word: string, lemma: string, value: JsonValue, occurrence = 0) {
  const selected = mappedWord(text, word, occurrence)
  return planAdd(text, { span: selected.span, selected: selected.selected, lemma, value })
}

describe('Markdown protocol parser', () => {
  it('indexes multiple real GFM references and keeps ordinary footnotes', () => {
    const text = [
      'She went[^w-go], then *goes*[^w-go]. A note[^1].',
      '',
      '[^1]: ordinary note',
      '',
      START,
      '[^w-go]: {"word":"go","translation":"去"}',
      END,
      ''
    ].join('\n')
    const parsed = parseDocument(text)

    expect(parsed.writable).toBe(true)
    expect(parsed.entries.size).toBe(1)
    expect(parsed.entries.get('go')).toMatchObject({
      lemma: 'go',
      value: { word: 'go', translation: '去' },
      managed: true,
      referenceSpans: expect.arrayContaining([expect.any(Object), expect.any(Object)])
    })
    expect(parsed.footnoteReferences).toHaveLength(3)
    expect(parsed.entries.get('go')?.referenceSpans).toHaveLength(2)
  })

  it('accepts all JSON root value types, including null', () => {
    const text = `${START}\n[^w-go]: null\n[^w-run]: [1,"x",false]\n${END}\n`
    const parsed = parseDocument(text)
    expect(parsed.entries.get('go')?.value).toBeNull()
    expect(parsed.entries.get('run')?.value).toEqual([1, 'x', false])
    expect(exportVocabulary(text)).toEqual({ ok: true, value: '{"go":null,"run":[1,"x",false]}' })
  })

  it('does not treat code examples as references or definitions', () => {
    const text = [
      '`[^w-go]` and a real go[^w-go].',
      '',
      '```md',
      '[^w-other]: null',
      'literal [^w-go]',
      '```',
      '',
      `${START}`,
      '[^w-go]: null',
      `${END}`,
      ''
    ].join('\n')
    const parsed = parseDocument(text)
    expect(parsed.entries.get('go')?.referenceSpans).toHaveLength(1)
    expect(parsed.entries.has('other')).toBe(false)
    expect(parsed.footnoteDefinitions.some((definition) => definition.label === 'w-other')).toBe(false)
  })

  it('blocks writes and export for duplicate normalized definitions', () => {
    const text = `go[^w-go]\n\n[^w-go]: null\n[^w-GO]: false\n`
    const parsed = parseDocument(text)
    expect(parsed.writable).toBe(false)
    expect(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-vocab-definition')).toBe(true)
    expect(exportVocabulary(text).ok).toBe(false)
  })

  it('blocks writes and export for damaged managed rows but tolerates invalid outside JSON', () => {
    const outside = '[^w-go]: {bad}\n'
    expect(parseDocument(outside).writable).toBe(true)
    expect(parseDocument(outside).entries.size).toBe(0)
    const damaged = `${START}\n[^w-go]: {bad}\nunknown row\n${END}\n`
    expect(parseDocument(damaged).writable).toBe(false)
    expect(exportVocabulary(damaged).ok).toBe(false)
  })

  it('recognizes only complete well-formed managed marker pairs at the document end', () => {
    const missing = `${START}\n[^w-go]: null\n`
    const trailing = `${START}\n${END}\ntrailing\n`
    expect(parseDocument(missing).writable).toBe(false)
    expect(parseDocument(trailing).writable).toBe(false)
    expect(parseDocument('`<!-- caretlex:vocab:start -->`').managedBlock.present).toBe(false)
  })
})

describe('visible selection mapping', () => {
  it('maps repeated words in paragraphs, headings, lists, blockquotes, tables, and emphasis by node offsets', () => {
    const text = [
      '# go',
      '',
      'go then go and **run**.',
      '',
      '- go',
      '',
      '> go',
      '',
      '| first | second |',
      '| --- | --- |',
      '| go | run |'
    ].join('\n')
    const parsed = parseDocument(text)
    const plainRuns = parsed.textRuns.filter((run) => run.value.includes('go'))
    expect(plainRuns.length).toBeGreaterThanOrEqual(5)
    const occurrences = [
      { line: '# go', word: 'go' },
      { line: 'go then go and **run**.', word: 'go' },
      { line: '- go', word: 'go' },
      { line: '> go', word: 'go' },
      { line: '| go | run |', word: 'go' }
    ]
    for (const { line, word } of occurrences) {
      const absolute = text.indexOf(line) + line.indexOf(word)
      const run = parsed.textRuns.find((item) => item.sourceSpan.start <= absolute && item.sourceSpan.end >= absolute + word.length)
      expect(run).toBeDefined()
      const visibleStart = run!.boundaries.findIndex((offset) => offset === absolute)
      const mapped = mapVisibleRange(parsed, run!.sourceSpan, visibleStart, visibleStart + word.length)
      expect(mapped).toEqual({ ok: true, span: { start: absolute, end: absolute + word.length }, selected: word })
    }
    const emphasis = mappedWord(text, 'run')
    expect(text.slice(emphasis.span.start - 2, emphasis.span.start)).toBe('**')
    expect(emphasis.span).toEqual({ start: text.indexOf('run'), end: text.indexOf('run') + 3 })
  })

  it('maps Markdown escapes and character references only through proven source boundaries', () => {
    const text = String.raw`can't can\'t c&#97;t` + ' &amp; 😀 cat'
    const parsed = parseDocument(text)
    const mapped = mappedWord(text, "can't", 1)
    expect(text.slice(mapped.span.start, mapped.span.end)).toBe(String.raw`can\'t`)
    expect(validateSelection(text, mapped.span, "can't").ok).toBe(true)
    const entityWord = mappedWord(text, 'cat')
    expect(text.slice(entityWord.span.start, entityWord.span.end)).toBe('c&#97;t')
    const emojiRun = parsed.textRuns.find((run) => run.value.includes('cat'))!
    const catIndex = emojiRun.value.lastIndexOf('cat')
    const emojiMapped = mapVisibleRange(parsed, emojiRun.sourceSpan, catIndex, catIndex + 3)
    expect(emojiMapped.ok).toBe(true)
  })

  it('rejects partial words, multi-word selections, code, links, and unsupported ranges', () => {
    const text = 'foobar `code` [link](https://example.com) two words'
    const parsed = parseDocument(text)
    const prose = parsed.textRuns.find((run) => run.value.startsWith('foobar'))!
    expect(mapVisibleRange(parsed, prose.sourceSpan, 0, 3).ok).toBe(false)
    expect(mapVisibleRange(parsed, prose.sourceSpan, 0, 6).ok).toBe(true)
    const linkRun = parsed.textRuns.find((run) => run.value === 'link')!
    expect(mapVisibleRange(parsed, linkRun.sourceSpan, 0, 4).ok).toBe(false)
    expect(validateSelection(text, { start: text.indexOf('two'), end: text.indexOf('words') + 5 }, 'two words').ok).toBe(false)
  })

  it('uses UTF-16 source offsets after a BOM and preserves CRLF and mixed line endings', () => {
    const text = '\uFEFF# Title\r\n\r\nfirst went.\nsecond went.\r\n'
    const selected = mappedWord(text, 'went', 1)
    expect(selected.span.start).toBe(text.slice(1).lastIndexOf('went'))
    const result = planAdd(text, { span: selected.span, selected: 'went', lemma: 'go', value: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.text.startsWith('\uFEFF# Title\r\n\r\nfirst went.\nsecond went[^w-go].\r\n')).toBe(true)
    expect(result.value.text.slice(0, text.indexOf('second'))).toBe(text.slice(0, text.indexOf('second')))
    expect(result.value.text).toContain(`${START}\r\n[^w-go]: null\r\n${END}\r\n`)
  })
})

describe('targeted vocabulary patches', () => {
  it('adds a new term, reuses it without changing the definition, and no-ops on a repeated click', () => {
    const initial = '# Text\n\nShe went. He goes.\n'
    const first = add(initial, 'went', 'go', { word: 'go', translation: '去' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.changed).toBe(true)
    expect(first.value.text).toContain('She went[^w-go]. He goes.')
    expect(first.value.text).toContain('[^w-go]: {"word":"go","translation":"去"}')

    const second = add(first.value.text, 'goes', 'go', { word: 'other', translation: 'ignored' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.text).toContain('He goes[^w-go].')
    expect(second.value.text.match(/\[\^w-go\]:/g)).toHaveLength(1)
    const repeated = add(second.value.text, 'goes', 'go', { word: 'other' })
    expect(repeated).toEqual({ ok: true, value: { text: second.value.text, changed: false, patches: [] } })
  })

  it('inserts a vocabulary reference alongside an ordinary footnote without removing it', () => {
    const text = 'went[^1]\n\n[^1]: note\n'
    const result = add(text, 'went', 'go', null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.text).toContain('went[^w-go][^1]')
    expect(result.value.text).toContain('[^1]: note')
  })

  it('refuses outside definitions and a different vocabulary reference at the target position', () => {
    expect(add('go go\n\n[^w-go]: null\n', 'go', 'go', null).ok).toBe(false)
    const conflict = add('word[^w-run]\n\n[^w-run]: null\n', 'word', 'go', null)
    expect(conflict.ok).toBe(false)
  })

  it('edits the managed JSON value and deletes all real references while retaining code examples', () => {
    const initial = `go[^w-go] and went[^w-go].\n\n\`[^w-go]\`\n\n${START}\n[^w-go]: {"word":"go"}\n${END}\n`
    const edited = planEdit(initial, { lemma: 'go', value: null })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.value.text).toContain('[^w-go]: null')
    const deleted = planDelete(edited.value.text, { lemma: 'go' })
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.value.text).toContain('go and went.')
    expect(deleted.value.text).toContain('`[^w-go]`')
    expect(deleted.value.text).toContain(`${START}\n${END}`)
  })

  it('sorts exports by lemma and rejects export from a damaged block', () => {
    const text = `${START}\n[^w-zebra]: 1\n[^w-apple]: null\n${END}\n`
    expect(exportVocabulary(text)).toEqual({ ok: true, value: '{"apple":null,"zebra":1}' })
    expect(exportVocabulary(`${START}\nunknown\n${END}\n`).ok).toBe(false)
  })
})

describe('settings schema and JSON Pointer bindings', () => {
  it('accepts the default settings and instantiates a required manual field', () => {
    expect(parseSettings(JSON.stringify(defaultSettings))).toEqual({ ok: true, value: defaultSettings })
    const created = instantiateTemplate(defaultSettings, { selected: 'went', lemma: 'go', sentence: 'She went home.' }, {
      '/translation': '去'
    })
    expect(created).toEqual({
      ok: true,
      value: { word: 'go', translation: '去', example: 'She went home.' }
    })
  })

  it('supports a root JSON Pointer and arbitrary JSON values', () => {
    const settings = parseSettings(JSON.stringify({
      version: 1,
      theme: 'dark',
      providers: ['manual'],
      entryTemplate: null,
      bindings: { '': { from: 'constant', value: ['x', null] } }
    }))
    expect(settings.ok).toBe(true)
    if (!settings.ok) return
    expect(instantiateTemplate(settings.value, { selected: 'a', lemma: 'a', sentence: '' })).toEqual({ ok: true, value: ['x', null] })
  })

  it('rejects malformed pointers, missing targets, overlaps, and unsupported providers', () => {
    const base = { version: 1, theme: 'system', providers: ['manual'], entryTemplate: { a: { b: '' } } }
    expect(parseSettings(JSON.stringify({ ...base, bindings: { '/a~2b': { from: 'lemma' } } })).ok).toBe(false)
    expect(parseSettings(JSON.stringify({ ...base, bindings: { '/absent': { from: 'lemma' } } })).ok).toBe(false)
    expect(parseSettings(JSON.stringify({ ...base, bindings: { '/a': { from: 'lemma' }, '/a/b': { from: 'selected' } } })).ok).toBe(false)
    expect(parseSettings(JSON.stringify({ ...base, providers: ['manual', 'online'], bindings: {} })).ok).toBe(false)
  })
})
