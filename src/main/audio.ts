import { isPronunciationUrl } from '../shared/dictionary'
import type { JsonValue } from '../shared/types'
import type { AudioStore, StoredAudio } from './audio-store'

const MAX_AUDIO_BYTES = 1024 * 1024
const TIMEOUT_MS = 8000

export interface AudioFetcher {
  /** 先查本地库，未命中再向 Merriam-Webster 媒体地址抓取；失败返回 undefined。 */
  load(url: string): Promise<StoredAudio | undefined>
  /** 保存词条后的后台抓取；不阻塞调用方，错误吞掉。 */
  prefetch(value: JsonValue): void
}

function audioUrl(value: JsonValue): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = (value as Record<string, JsonValue>).audio
  return typeof raw === 'string' && isPronunciationUrl(raw) ? raw : undefined
}

export function createAudioFetcher(deps: { fetch: typeof fetch; store: AudioStore }): AudioFetcher {
  const load = async (url: string): Promise<StoredAudio | undefined> => {
    if (!isPronunciationUrl(url)) return undefined
    const cached = deps.store.get(url)
    if (cached) return cached
    try {
      const response = await deps.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
      if (!response.ok || !mime.startsWith('audio/') || !response.body) { await response.body?.cancel(); return undefined }
      if (Number(response.headers.get('content-length') ?? 0) > MAX_AUDIO_BYTES) { await response.body.cancel(); return undefined }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) break
          total += item.value.byteLength
          if (total > MAX_AUDIO_BYTES) { await reader.cancel(); return undefined }
          chunks.push(item.value)
        }
      } finally { reader.releaseLock() }
      const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total)
      if (!bytes.byteLength) return undefined
      deps.store.put(url, mime, bytes)
      return { mime, bytes }
    } catch { return undefined }
  }
  return {
    load,
    prefetch(value) {
      const url = audioUrl(value)
      if (!url || deps.store.has(url)) return
      void load(url).catch(() => undefined)
    }
  }
}
