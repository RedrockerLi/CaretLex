import type { JsonValue } from './types'
import type { ProviderIssue } from './providers'

export interface DictionarySense { id: string; definition: string; examples: string[] }
export interface DictionaryCandidate { entryId: string; lemma: string; partOfSpeech?: string; ipa?: string; audio?: string; senses: DictionarySense[] }
export interface DictionaryLookup { query: string; candidates: DictionaryCandidate[]; fetchedAt: number }

const AUDIO_BASE = 'https://media.merriam-webster.com/audio/prons/en/us/mp3'
const AUDIO_ID = /^[A-Za-z0-9_]+$/
const AUDIO_URL = /^https:\/\/media\.merriam-webster\.com\/audio\/prons\/en\/us\/mp3\/(bix|gg|number|[a-z])\/[A-Za-z0-9_]+\.mp3$/

/** Merriam-Webster 发音文件名到媒体地址；子目录规则见 API 文档。 */
export function pronunciationUrl(id: string): string | undefined {
  if (!AUDIO_ID.test(id)) return undefined
  const subdirectory = id.startsWith('bix') ? 'bix' : id.startsWith('gg') ? 'gg' : /^[A-Za-z]/.test(id) ? id[0].toLowerCase() : 'number'
  return `${AUDIO_BASE}/${subdirectory}/${id}.mp3`
}

/** 只放行 Merriam-Webster 发音媒体地址，避免词条里的任意地址被主进程请求。 */
export function isPronunciationUrl(value: string): boolean {
  return AUDIO_URL.test(value)
}

const MAX_CANDIDATES = 8
const MAX_SENSES_PER_ENTRY = 6
const MAX_TOTAL_SENSES = 24
const MAX_REFERENCE_BYTES = 32 * 1024
const MAX_DEFINITION_CHARS = 400
const MAX_EXAMPLE_CHARS = 300
const MAX_OTHER_MEANINGS = 8
const MAX_ASSEMBLED_TEXT_CHARS = 2000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

export function cleanDictionaryText(text: string): string {
  return text
    .replace(/\{bc\}/g, ': ')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^:\s*/, '')
    .trim()
}

function normalizeHeadword(text: string): string {
  return cleanDictionaryText(text).replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

interface ParsedEntry {
  entryId: string
  headword: string
  partOfSpeech?: string
  ipa?: string
  audio?: string
  stems: string[]
  senses: DictionarySense[]
}

function extractSense(value: Record<string, unknown>): { definition: string; examples: string[] } {
  const texts: string[] = []
  const examples: string[] = []
  const visit = (node: unknown) => {
    if (!Array.isArray(node)) return
    if (node[0] === 'text' && typeof node[1] === 'string') { texts.push(node[1]); return }
    if (node[0] === 'vis' && Array.isArray(node[1])) {
      for (const item of node[1]) if (isRecord(item) && typeof item.t === 'string') examples.push(cleanDictionaryText(item.t))
      return
    }
    for (const item of node) visit(item)
  }
  visit(value.dt)
  return {
    definition: cleanDictionaryText(texts.join(' ')),
    examples: [...new Set(examples.filter(Boolean))].slice(0, 3)
  }
}

function collectSenses(def: unknown, entryId: string): DictionarySense[] {
  const senses: DictionarySense[] = []
  let counter = 0
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (Array.isArray(item) && (item[0] === 'sense' || item[0] === 'sen') && isRecord(item[1])) {
          const extracted = extractSense(item[1])
          if (extracted.definition) senses.push({ id: `${entryId}#${counter++}`, ...extracted })
          visit(item[1])
        } else visit(item)
      }
    } else if (isRecord(node)) {
      for (const value of Object.values(node)) visit(value)
    }
  }
  visit(def)
  return senses
}

function parseEntry(value: unknown, index: number): ParsedEntry | undefined {
  if (!isRecord(value)) return undefined
  const meta = isRecord(value.meta) ? value.meta : {}
  const hwi = isRecord(value.hwi) ? value.hwi : {}
  const headword = normalizeHeadword(stringValue(hwi.hw) ?? '')
  if (!headword) return undefined
  const entryId = stringValue(meta.id) ?? `entry-${index}`
  const stems = arrayValue(meta.stems)
    .map(item => typeof item === 'string' ? item.trim().toLowerCase() : '')
    .filter(Boolean)
  const prs = arrayValue(hwi.prs)
  const ipa = prs.map(item => isRecord(item) ? stringValue(item.ipa) : undefined).find((item): item is string => !!item)
  const audio = prs
    .map(item => isRecord(item) && isRecord(item.sound) ? stringValue(item.sound.audio) : undefined)
    .find((item): item is string => !!item && AUDIO_ID.test(item))
  let senses = collectSenses(value.def, entryId)
  if (!senses.length) {
    senses = arrayValue(value.shortdef)
      .map((item, senseIndex): DictionarySense | undefined => {
        const definition = typeof item === 'string' ? cleanDictionaryText(item) : ''
        return definition ? { id: `${entryId}#s${senseIndex}`, definition, examples: [] } : undefined
      })
      .filter((item): item is DictionarySense => !!item)
  }
  return {
    entryId,
    headword,
    ...(typeof value.fl === 'string' && value.fl.trim() ? { partOfSpeech: value.fl.trim() } : {}),
    ...(ipa ? { ipa } : {}),
    ...(audio ? { audio } : {}),
    stems,
    senses
  }
}

function selectCandidates(entries: ParsedEntry[], query: string): ParsedEntry[] {
  const queryNorm = normalizeHeadword(query)
  const stub = entries.find(entry => entry.senses.length === 0)
  if (stub) {
    const target = stub.stems.find(stem => {
      if (!stem || stem === queryNorm || stem.includes(' ')) return false
      return entries.some(entry => entry.senses.length > 0 && entry.headword === stem)
    })
    if (target) {
      const entry = entries.find(item => item.senses.length > 0 && item.headword === target)
      return entry ? [entry] : []
    }
  }
  const exact: ParsedEntry[] = []
  const fallback: ParsedEntry[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.senses.length) continue
    const isExact = entry.headword === queryNorm
    const isFallback = !isExact && !entry.headword.includes(' ') && entry.stems.includes(queryNorm)
    if (!isExact && !isFallback) continue
    if (seen.has(entry.entryId)) continue
    seen.add(entry.entryId)
    if (isExact) {
      exact.push(entry)
      if (exact.length >= MAX_CANDIDATES) break
    } else if (!fallback.length) {
      fallback.push(entry)
    }
    if (exact.length + fallback.length >= MAX_CANDIDATES) break
  }
  return exact.length ? [...exact, ...fallback] : fallback
}

function limitSenses(entries: ParsedEntry[]): ParsedEntry[] {
  let total = 0
  const limited: ParsedEntry[] = []
  for (const entry of entries) {
    const remaining = MAX_TOTAL_SENSES - total
    if (remaining <= 0) break
    const senses = entry.senses.slice(0, Math.min(MAX_SENSES_PER_ENTRY, remaining))
    if (!senses.length) continue
    total += senses.length
    limited.push({ ...entry, senses })
  }
  return limited
}

export function normalizeLearnersResponse(query: string, raw: unknown): DictionaryLookup {
  const entries: ParsedEntry[] = []
  for (const [index, value] of arrayValue(raw).entries()) {
    const entry = parseEntry(value, index)
    if (entry) entries.push(entry)
  }
  const candidates = limitSenses(selectCandidates(entries, query)).map(entry => ({
    entryId: entry.entryId,
    lemma: entry.headword,
    ...(entry.partOfSpeech ? { partOfSpeech: entry.partOfSpeech } : {}),
    ...(entry.ipa ? { ipa: entry.ipa } : {}),
    ...(entry.audio ? { audio: entry.audio } : {}),
    senses: entry.senses
  }))
  return { query: normalizeHeadword(query), candidates, fetchedAt: Date.now() }
}

export function buildDictionaryReference(lookup: DictionaryLookup, word: string): JsonValue {
  const reference = {
    available: true,
    word,
    candidates: lookup.candidates.map(candidate => ({
      lemma: candidate.lemma,
      ...(candidate.partOfSpeech ? { part_of_speech: candidate.partOfSpeech } : {}),
      senses: candidate.senses.map(sense => ({
        id: sense.id,
        definition: truncate(sense.definition, MAX_DEFINITION_CHARS),
        ...(sense.examples.length ? { examples: [truncate(sense.examples[0], MAX_EXAMPLE_CHARS)] } : {})
      }))
    }))
  } as { available: boolean; word: string; candidates: Array<{ lemma: string; part_of_speech?: string; senses: Array<{ id: string; definition: string; examples?: string[] }> }> }
  while (JSON.stringify(reference).length > MAX_REFERENCE_BYTES) {
    const last = reference.candidates[reference.candidates.length - 1]
    if (!last) break
    if (last.senses.length > 1) last.senses.pop()
    else if (reference.candidates.length > 1) reference.candidates.pop()
    else if (last.senses.length === 1) last.senses.pop()
    else break
  }
  if (!reference.candidates.length) return { available: false, word, reason: 'reference-too-large' }
  return reference
}

export function assembleEnrichedEntry(raw: JsonValue, lookup: DictionaryLookup | undefined): { ok: true; value: Record<string, JsonValue>; issues: ProviderIssue[] } | { ok: false; error: ProviderIssue } {
  if (!isRecord(raw)) return { ok: false, error: { code: 'dictionary-invalid-llm', message: 'LLM 响应不是 JSON 对象。' } }
  const issues: ProviderIssue[] = []
  const senseIndex = new Map<string, { candidate: DictionaryCandidate; sense: DictionarySense }>()
  const candidatesByLemma = new Map<string, DictionaryCandidate[]>()
  for (const candidate of lookup?.candidates ?? []) {
    const list = candidatesByLemma.get(candidate.lemma) ?? []
    list.push(candidate)
    candidatesByLemma.set(candidate.lemma, list)
    for (const sense of candidate.senses) senseIndex.set(sense.id, { candidate, sense })
  }
  const text = (record: Record<string, unknown>, key: string): string => typeof record[key] === 'string' ? record[key] as string : ''
  const contextId = text(raw, 'context_sense_id')
  const contextMatch = contextId ? senseIndex.get(contextId) : undefined
  let lemma = text(raw, 'lemma').trim().toLowerCase()
  if (lookup?.candidates.length) {
    if (contextMatch && contextMatch.candidate.lemma !== lemma) {
      issues.push({ code: 'dictionary-lemma-mismatch', message: `LLM 选择的义项属于 ${contextMatch.candidate.lemma}，lemma 已按义项修正。`, sourcePath: 'lemma' })
      lemma = contextMatch.candidate.lemma
    } else if (!candidatesByLemma.has(lemma)) {
      const fallback = contextMatch?.candidate.lemma ?? lookup.candidates[0].lemma
      issues.push({ code: 'dictionary-lemma-mismatch', message: `LLM 返回的 lemma 不在词典候选中，已改为 ${fallback}。`, sourcePath: 'lemma' })
      lemma = fallback
    }
  }
  let englishDefinition = text(raw, 'english_definition')
  if (contextMatch) englishDefinition = contextMatch.sense.definition
  else if (!englishDefinition.trim() && lemma) {
    englishDefinition = candidatesByLemma.get(lemma)?.[0]?.senses[0]?.definition ?? ''
  }
  if (!englishDefinition.trim()) issues.push({ code: 'dictionary-sense-missing', message: '上下文义项没有可用的英文释义，请人工检查。', sourcePath: 'english_definition' })
  const otherMeanings: JsonValue[] = []
  const seenSenses = new Set<string>()
  for (const item of arrayValue(raw.other_meanings).slice(0, MAX_OTHER_MEANINGS)) {
    if (!isRecord(item)) continue
    const senseId = text(item, 'sense_id')
    const match = senseId ? senseIndex.get(senseId) : undefined
    const valid = match && match.candidate.lemma === lemma && match.sense.id !== contextId ? match : undefined
    if (match && match.candidate.lemma !== lemma) issues.push({ code: 'dictionary-sense-mismatch', message: `义项 ${match.sense.id} 属于 ${match.candidate.lemma}，已忽略该词典释义。`, sourcePath: 'other_meanings' })
    if (valid) {
      if (seenSenses.has(valid.sense.id)) continue
      seenSenses.add(valid.sense.id)
      otherMeanings.push({
        meaning: truncate(text(item, 'meaning'), MAX_ASSEMBLED_TEXT_CHARS),
        english_definition: valid.sense.definition,
        example_sentence: truncate(text(item, 'example_sentence'), MAX_ASSEMBLED_TEXT_CHARS)
      })
      continue
    }
    const fallbackDefinition = truncate(text(item, 'english_definition'), MAX_ASSEMBLED_TEXT_CHARS)
    const meaning = truncate(text(item, 'meaning'), MAX_ASSEMBLED_TEXT_CHARS)
    const example = truncate(text(item, 'example_sentence'), MAX_ASSEMBLED_TEXT_CHARS)
    if (senseId && !fallbackDefinition.trim()) continue
    if (!meaning.trim() && !fallbackDefinition.trim() && !example.trim()) continue
    otherMeanings.push({ meaning, english_definition: fallbackDefinition, example_sentence: example })
  }
  const matched = contextMatch?.candidate ?? candidatesByLemma.get(lemma)?.[0]
  return {
    ok: true,
    value: {
      lemma,
      ipa: matched?.ipa ?? '',
      audio: matched?.audio ? pronunciationUrl(matched.audio) ?? '' : '',
      meaning_in_context: truncate(text(raw, 'meaning_in_context'), MAX_ASSEMBLED_TEXT_CHARS),
      english_definition: englishDefinition,
      other_meanings: otherMeanings
    },
    issues
  }
}
