import type { EntryLocation, SourceResult } from './bridge'
import type { AppSettings } from './settings'
import type { ArticleData } from './providers'
import type { CoreResult, JsonValue, VocabRecord } from './types'
import { EntrySession } from './entry-session'

export type QuickAddState = 'queued' | 'fetching' | 'saving' | 'saved' | 'failed'

/** One background save started from the selection toolbar. */
export interface QuickAddJob {
  id: string
  /** Source span is kept in the coordinate system of the current document text. */
  location: EntryLocation
  boundLemma?: string
  lemma: string
  article?: ArticleData
  result?: SourceResult
  state: QuickAddState
  /** Provider sources beyond the local article were available when the entry was built. */
  usedSources: boolean
  /** Non-fatal problem from the article or provider request; the entry is still written. */
  notice?: string
  /** Save failure; the entry was not written and the job stays queued for retry. */
  failure?: string
}

/** `planAdd` inserts this at the end of the selection. */
export function referenceInsertLength(lemma: string): number {
  return lemma.length + 5
}

/**
 * Every queued span was captured against the text of its own click, so an earlier
 * write shifts every later one. Spans ending at or before the insertion point stay put.
 */
export function shiftJobSpans(jobs: readonly QuickAddJob[], savedId: string, insertAt: number, length: number): QuickAddJob[] {
  if (length <= 0) return [...jobs]
  return jobs.map(job => {
    if (job.id === savedId || job.location.sourceSpan.start < insertAt) return job
    const { start, end } = job.location.sourceSpan
    return { ...job, location: { ...job.location, sourceSpan: { start: start + length, end: end + length } } }
  })
}

/**
 * Rebuilds the final entry from the captured article and provider result through the
 * same session logic the composer uses: lemma suggestion, template mapping, blank-field
 * merge against the existing record, and identity validation.
 */
export function buildQuickAddEntry(
  job: QuickAddJob,
  settings: AppSettings,
  settingsRevision: string,
  records: Map<string, VocabRecord>
): CoreResult<{ lemma: string; value: JsonValue; usedSources: boolean }> {
  const session = new EntrySession(job.location, settings, settingsRevision, records, job.boundLemma)
  if (job.article) session.setArticle(job.article)
  if (job.result) { session.startRequest(job.result.requestId); session.receive(job.result) }
  const parsed = session.parse()
  if (!parsed.ok) return { ok: false, error: { code: 'invalid-entry', message: parsed.message } }
  const usedSources = !!job.result && Object.keys(job.result.sources).some(name => name !== 'article')
  return { ok: true, value: { lemma: session.lemma, value: parsed.value, usedSources } }
}
