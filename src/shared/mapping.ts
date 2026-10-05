import { isJsonValue, cloneJson } from './json'
import { checkResponse, jsonKind, type ProviderIssue } from './providers'
import type { CoreResult, JsonValue } from './types'

type Token = string | number | '*'
interface Reference { source: string; tokens: Token[] }
export interface MappingSources { values: Record<string, JsonValue>; examples?: Record<string, JsonValue> }
export interface MappingOutput { value: JsonValue; issues: ProviderIssue[] }
function reference(value: string): Reference | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)\.(.+)$/.exec(value)
  if (!match) return undefined
  const tokens: Token[] = []
  let rest = match[2]
  while (rest) {
    const key = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest)
    if (!key) return undefined
    tokens.push(key[0]); rest = rest.slice(key[0].length)
    while (rest.startsWith('[')) {
      const index = /^\[(0|[1-9]\d*)?\]/.exec(rest)
      if (!index) return undefined
      const n = index[1] === undefined ? '*' : Number(index[1])
      if (n !== '*' && !Number.isSafeInteger(n)) return undefined
      tokens.push(n); rest = rest.slice(index[0].length)
    }
    if (!rest) break
    if (!rest.startsWith('.')) return undefined
    rest = rest.slice(1)
    if (!rest) return undefined
  }
  return { source: match[1], tokens }
}
function pathOf(ref: Reference, count = ref.tokens.length): string {
  return ref.source + ref.tokens.slice(0, count).map(token => typeof token === 'string' && token !== '*' ? `.${token}` : token === '*' ? '[]' : `[${token}]`).join('')
}
function literal(value: JsonValue): value is { $literal: JsonValue } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, '$literal')
}
function ownReferences(value: JsonValue): Reference[] {
  if (literal(value) || Array.isArray(value)) return []
  if (typeof value === 'string') { const ref = reference(value); return ref ? [ref] : [] }
  if (value && typeof value === 'object') return Object.values(value).flatMap(ownReferences)
  return []
}
function templateWalk(value: JsonValue, bound: Set<string>): string | undefined {
  if (literal(value)) return undefined
  if (typeof value === 'string') {
    const ref = reference(value)
    if (!ref && /^[A-Za-z_][A-Za-z0-9_-]*\.[^\s]*$/.test(value)) return `来源引用 ${value} 的路径格式无效。`
    if (ref?.tokens.some((token, index) => token === '*' && !bound.has(pathOf(ref, index)))) return `展开引用 ${value} 缺少对应输出数组层级。`
    return undefined
  }
  if (Array.isArray(value)) {
    const lists = new Set<string>()
    for (const child of value) for (const ref of ownReferences(child)) {
      const unresolved = ref.tokens.flatMap((token, index) => token === '*' && !bound.has(pathOf(ref, index)) ? [pathOf(ref, index)] : [])
      if (unresolved.length > 1) return `${pathOf(ref)} 的多个 [] 缺少明确输出层级。`
      unresolved.forEach(list => lists.add(list))
    }
    if (lists.size > 1 || (lists.size && value.length !== 1)) return '每个动态输出数组必须只有一个元素模板，并且只能展开一个来源列表。'
    const next = new Set([...bound, ...lists])
    for (const child of value) { const error = templateWalk(child, next); if (error) return error }
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) { const error = templateWalk(child, bound); if (error) return error }
  }
  return undefined
}
export function validateMappingTemplate(template: unknown): CoreResult<true> {
  if (!isJsonValue(template)) return { ok: false, error: { code: 'invalid-template', message: '保存模板必须是有限且可序列化的 JSON。' } }
  const error = templateWalk(template, new Set())
  return error ? { ok: false, error: { code: 'invalid-expansion', message: error } } : { ok: true, value: true }
}
function get(ref: Reference, roots: Record<string, JsonValue>, indices: Map<string, number>, example = false): JsonValue | undefined {
  let value: JsonValue | undefined = Object.hasOwn(roots, ref.source) ? roots[ref.source] : undefined
  for (let i = 0; i < ref.tokens.length; i++) {
    const token = ref.tokens[i]
    if (value === undefined || value === null) return undefined
    if (typeof token === 'number' || token === '*') {
      if (!Array.isArray(value)) return undefined
      const index = example ? 0 : token === '*' ? indices.get(pathOf(ref, i)) : token
      if (index === undefined || !Object.hasOwn(value, index)) return undefined
      value = value[index]
    } else {
      if (typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, token)) return undefined
      value = value[token]
    }
  }
  return value
}
export function instantiateMapping(template: JsonValue, sources: MappingSources): CoreResult<MappingOutput> {
  const valid = validateMappingTemplate(template)
  if (!valid.ok) return valid
  const issues: ProviderIssue[] = []
  const resolve = (ref: Reference, indices: Map<string, number>): JsonValue => {
    const actual = get(ref, sources.values, indices)
    const expected = get(ref, sources.examples ?? {}, indices, true)
    const at = pathOf(ref)
    if (actual === undefined || (expected !== undefined && checkResponse(actual, expected).some(issue => issue.code !== 'empty-field'))) {
      issues.push({ code: actual === undefined ? 'missing-source' : 'invalid-source', message: `${at} 不可用或不符合响应示例，待手填。`, sourcePath: at })
      return expected !== undefined && jsonKind(expected) === 'string' ? '' : null
    }
    if (typeof actual === 'string' && !actual.trim()) issues.push({ code: 'empty-source', message: `${at} 为空，待人工检查。`, sourcePath: at })
    return cloneJson(actual)
  }
  const walk = (value: JsonValue, indices: Map<string, number>): JsonValue => {
    if (literal(value)) return cloneJson(value.$literal)
    if (typeof value === 'string') { const ref = reference(value); return ref ? resolve(ref, indices) : value }
    if (Array.isArray(value)) {
      const refs = value.flatMap(ownReferences)
      const dynamic = refs.find(ref => ref.tokens.some((token, index) => token === '*' && !indices.has(pathOf(ref, index))))
      if (!dynamic) return value.map(item => walk(item, indices))
      const index = dynamic.tokens.findIndex((token, i) => token === '*' && !indices.has(pathOf(dynamic, i)))
      const listRef = { source: dynamic.source, tokens: dynamic.tokens.slice(0, index) }
      const listPath = pathOf(listRef)
      const list = get(listRef, sources.values, indices)
      if (!Array.isArray(list)) {
        issues.push({ code: 'missing-list', message: `${listPath} 不是可用列表，输出 []，待手填。`, sourcePath: listPath })
        return []
      }
      return list.map((_item, row) => walk(value[0], new Map([...indices, [listPath, row]])))
    }
    if (value && typeof value === 'object') {
      const result: Record<string, JsonValue> = Object.create(null)
      for (const [key, child] of Object.entries(value)) result[key] = walk(child, indices)
      return result
    }
    return value
  }
  return { ok: true, value: { value: walk(template, new Map()), issues } }
}
export function renameSource(value: JsonValue, oldName: string, newName: string): JsonValue {
  if (literal(value)) return cloneJson(value)
  if (typeof value === 'string') { const ref = reference(value); return ref?.source === oldName ? newName + value.slice(oldName.length) : value }
  if (Array.isArray(value)) return value.map(item => renameSource(item, oldName, newName))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renameSource(item, oldName, newName)]))
  return value
}
export function referencesSource(value: JsonValue, name: string): boolean {
  if (literal(value)) return false
  if (typeof value === 'string') return reference(value)?.source === name
  if (Array.isArray(value)) return value.some(item => referencesSource(item, name))
  return !!value && typeof value === 'object' && Object.values(value).some(item => referencesSource(item, name))
}
