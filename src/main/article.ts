import { sentences } from 'sbd'
import { parseDocument, validateSelection } from '../shared/protocol'
import type { CoreResult, SourceSpan } from '../shared/types'
import type { ArticleData } from '../shared/providers'
import type { Nodes } from 'mdast'

function fail(message: string): CoreResult<never> { return { ok: false, error: { code: 'article-unavailable', message } } }
/** sbd supplies abbreviation/number/URL boundaries. This adapter preserves offsets and applies explicit quote/ellipsis rules. */
export function sentenceRanges(text: string): SourceSpan[] | undefined {
  const base = sentences(text, { preserve_whitespace: true, newline_boundaries: false })
  let cursor = 0
  const boundaries = new Set<number>()
  for (const sentence of base) {
    // sbd may trim only outside whitespace. Recover it by forward comparison, never by word search.
    while (cursor < text.length && /\s/.test(text[cursor]) && !sentence.startsWith(text[cursor])) cursor++
    if (text.slice(cursor, cursor + sentence.length) !== sentence) return undefined
    cursor += sentence.length
    boundaries.add(cursor)
  }
  if (text.slice(cursor).trim()) return undefined
  for (const match of text.matchAll(/(?:[.!?]+|…+)["'”’»)]*/g)) {
    let end = match.index! + match[0].length
    const punctuation = match[0]
    if (end < text.length && !/\s/.test(text[end])) continue
    const tail = text.slice(end)
    const next = /^\s+["'“‘(]*([A-Za-z])/.exec(tail)
    if (!next) continue
    const before = text.slice(0, match.index! + 1)
    // These abbreviations never terminate a sentence in the declared English rules.
    if (/(?:\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e))\.$/i.test(before)) {
      for (const boundary of boundaries) if (boundary >= end && boundary <= end + (tail.match(/^\s*/)?.[0].length ?? 0)) boundaries.delete(boundary)
      continue
    }
    const ellipsis = punctuation.includes('…') || punctuation.startsWith('...')
    const reported = /[!?]["'”’]/.test(punctuation) && /^\s+(?:he|she|they|we|I|it)\s+(?:said|asked|shouted|whispered|replied|cried|yelled|exclaimed)\b/.test(tail)
    if (reported || (ellipsis && next[1] === next[1].toLowerCase())) {
      for (const boundary of boundaries) if (boundary >= match.index! && boundary <= end + (tail.match(/^\s*/)?.[0].length ?? 0)) boundaries.delete(boundary)
    } else if (/[!?]/.test(punctuation) || (ellipsis && /[A-Z]/.test(next[1])) || /\bU\.S\.$/.test(before) || (/\.["'”’]/.test(punctuation) && /[A-Z]/.test(next[1]))) boundaries.add(end)
  }
  // Normalize proposed boundaries to follow closing quotes without altering the text.
  const normalized = new Set<number>()
  for (let end of boundaries) {
    while (end > 0 && /\s/.test(text[end - 1])) end--
    while (end < text.length && /["'”’»)]/.test(text[end])) end++
    if (end) normalized.add(end)
  }
  normalized.add(text.length)
  const ranges: SourceSpan[] = []
  let start = 0
  for (let end of [...normalized].sort((a, b) => a - b)) {
    const originalEnd = end
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    if (end > start) ranges.push({ start, end })
    start = originalEnd
  }
  return ranges
}
export function extractArticle(text: string, span: SourceSpan, selected: string): CoreResult<ArticleData> {
  const validated = validateSelection(text, span, selected)
  if (!validated.ok) return fail(validated.error.message)
  const parsed = parseDocument(text)
  const run = parsed.textRuns.find(item => item.boundaries.includes(span.start) && item.boundaries.includes(span.end))
  if (!run) return fail('无法定位选词的可见文本节点。')
  const from = run.boundaries.indexOf(span.start); const to = run.boundaries.indexOf(span.end)
  if (run.value.slice(from, to) !== selected) return fail('选词与可见文本不一致。')
  let block: Nodes | undefined
  const find = (node: Nodes) => {
    const start = node.position?.start.offset; const end = node.position?.end.offset
    if (start === undefined || end === undefined || start > span.start || end < span.end) return
    if (['paragraph', 'heading', 'tableCell'].includes(node.type)) block = node
    if ('children' in node) node.children.forEach(find)
  }
  find(parsed.tree)
  if (!block) return fail('选词没有可识别的段落、标题或表格单元格。')
  let visible = ''; let selectedStart: number | undefined; let selectedEnd: number | undefined
  const hard: number[] = [0]
  let unsupported = false
  const collect = (node: Nodes) => {
    if (['footnoteReference', 'footnoteDefinition', 'definition'].includes(node.type)) return
    if (node.type === 'break') { hard.push(visible.length); visible += '\n'; hard.push(visible.length); return }
    if (node.type === 'html') { unsupported = true; return }
    if (node.type === 'image' || node.type === 'imageReference') { visible += node.alt ?? ''; return }
    if (node.type === 'text' && node.position?.start.offset === run.sourceSpan.start && node.position?.end.offset === run.sourceSpan.end) {
      selectedStart = visible.length + from; selectedEnd = visible.length + to
    }
    if ('children' in node) node.children.forEach(collect)
    else if ('value' in node && typeof node.value === 'string') visible += node.value
  }
  collect(block)
  if (unsupported || selectedStart === undefined || selectedEnd === undefined) return fail('原句包含无法可靠提取的节点，保留手动录入。')
  hard.push(visible.length)
  for (let index = 0; index < hard.length - 1; index++) {
    const start = hard[index]; const end = hard[index + 1]
    if (selectedStart < start || selectedEnd > end) continue
    const segment = visible.slice(start, end)
    const ranges = sentenceRanges(segment)
    if (!ranges) return fail('英文分句未能保留原句字符，保留手动录入。')
    const sentence = ranges.find(range => range.start + start <= selectedStart! && range.end + start >= selectedEnd!)
    if (!sentence) return fail('无法定位完整原句。')
    const left = sentence.start + start; const right = sentence.end + start
    return { ok: true, value: { original_word: selected, original_sentence: visible.slice(left, selectedStart) + '[' + visible.slice(selectedStart, selectedEnd) + ']' + visible.slice(selectedEnd, right) } }
  }
  return fail('选词跨越硬换行或没有可用原句。')
}
