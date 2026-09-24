import type { CoreError, CoreResult, JsonValue } from './types'

export type Theme = 'system' | 'light' | 'dark'

export type BindingSource = 'selected' | 'lemma' | 'sentence' | 'manual' | 'constant'

export type SettingBinding =
  | { from: 'selected' | 'lemma' | 'sentence' }
  | { from: 'manual'; label?: string; required?: boolean }
  | { from: 'constant'; value: JsonValue }

export interface AppSettings {
  version: 1
  theme: Theme
  providers: ['manual']
  entryTemplate: JsonValue
  bindings: Record<string, SettingBinding>
}

export interface TemplateContext {
  selected: string
  lemma: string
  sentence: string
}

export type ManualValues = Record<string, JsonValue>

export const defaultSettings: AppSettings = {
  version: 1,
  theme: 'system',
  providers: ['manual'],
  entryTemplate: { word: '', translation: '', example: '' },
  bindings: {
    '/word': { from: 'lemma' },
    '/translation': { from: 'manual', label: '中文翻译', required: true },
    '/example': { from: 'sentence' }
  }
}

function error(code: string, message: string): CoreResult<never> {
  return { ok: false, error: { code, message } }
}

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonValue)
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(jsonValue)
  return false
}

function parsePointer(pointer: string): string[] | undefined {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) return undefined
  const segments = pointer.slice(1).split('/')
  const decoded: string[] = []
  for (const segment of segments) {
    if (/~(?![01])/.test(segment)) return undefined
    decoded.push(segment.replace(/~1/g, '/').replace(/~0/g, '~'))
  }
  return decoded
}

function pointerGet(root: JsonValue, segments: string[]): JsonValue | undefined {
  let value: JsonValue = root
  for (const segment of segments) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined
      const index = Number(segment)
      if (index >= value.length) return undefined
      value = value[index]
    } else if (value !== null && typeof value === 'object') {
      if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined
      value = value[segment]
    } else {
      return undefined
    }
  }
  return value
}

function bindingFor(value: unknown, pointer: string): CoreResult<SettingBinding> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return error('invalid-binding', `绑定 ${pointer} 必须是 JSON 对象。`)
  }
  const binding = value as Record<string, unknown>
  const from = binding.from
  if (from === 'selected' || from === 'lemma' || from === 'sentence') {
    if (Object.keys(binding).some((key) => key !== 'from')) {
      return error('invalid-binding', `绑定 ${pointer} 的 ${from} 来源不能包含额外字段。`)
    }
    return { ok: true, value: { from } }
  }
  if (from === 'manual') {
    if (Object.keys(binding).some((key) => !['from', 'label', 'required'].includes(key))) {
      return error('invalid-binding', `手动绑定 ${pointer} 含有未知字段。`)
    }
    if (binding.label !== undefined && typeof binding.label !== 'string') {
      return error('invalid-binding', `手动绑定 ${pointer} 的 label 必须是字符串。`)
    }
    if (binding.required !== undefined && typeof binding.required !== 'boolean') {
      return error('invalid-binding', `手动绑定 ${pointer} 的 required 必须是布尔值。`)
    }
    return {
      ok: true,
      value: {
        from,
        ...(typeof binding.label === 'string' ? { label: binding.label } : {}),
        ...(typeof binding.required === 'boolean' ? { required: binding.required } : {})
      }
    }
  }
  if (from === 'constant') {
    if (Object.keys(binding).some((key) => !['from', 'value'].includes(key))) {
      return error('invalid-binding', `常量绑定 ${pointer} 含有未知字段。`)
    }
    if (!Object.prototype.hasOwnProperty.call(binding, 'value') || !jsonValue(binding.value)) {
      return error('invalid-binding', `常量绑定 ${pointer} 必须包含合法 JSON value。`)
    }
    return { ok: true, value: { from, value: binding.value } }
  }
  return error('invalid-binding', `绑定 ${pointer} 的 from 来源无效。`)
}

function pathIsPrefix(left: string[], right: string[]): boolean {
  return left.length <= right.length && left.every((segment, index) => segment === right[index])
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, JsonValue> = Object.create(null)
    for (const [key, child] of Object.entries(value)) copy[key] = cloneJson(child)
    return copy
  }
  return value
}

function pointerSet(root: JsonValue, segments: string[], replacement: JsonValue): JsonValue {
  if (segments.length === 0) return replacement
  const [head, ...tail] = segments
  if (Array.isArray(root)) {
    const copy = root.slice()
    const index = Number(head)
    copy[index] = pointerSet(copy[index], tail, replacement)
    return copy
  }
  if (root !== null && typeof root === 'object') {
    const copy: Record<string, JsonValue> = Object.create(null)
    for (const [key, value] of Object.entries(root)) copy[key] = value
    copy[head] = pointerSet(copy[head], tail, replacement)
    return copy
  }
  return root
}

export function parseSettings(text: string): CoreResult<AppSettings> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    return error('invalid-settings-json', `设置文件不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return error('invalid-settings', '设置根值必须是 JSON 对象。')
  }
  const object = parsed as Record<string, unknown>
  if (object.version !== 1) return error('unsupported-settings-version', '设置 version 必须为 1。')
  if (object.theme !== 'system' && object.theme !== 'light' && object.theme !== 'dark') {
    return error('invalid-settings-theme', 'theme 必须是 system、light 或 dark。')
  }
  if (!Array.isArray(object.providers) || object.providers.length !== 1 || object.providers[0] !== 'manual') {
    return error('invalid-settings-providers', '首版 providers 必须严格为 ["manual"]。')
  }
  if (!jsonValue(object.entryTemplate)) return error('invalid-entry-template', 'entryTemplate 必须是合法 JSON 值。')
  if (!object.bindings || typeof object.bindings !== 'object' || Array.isArray(object.bindings)) {
    return error('invalid-bindings', 'bindings 必须是 JSON Pointer 到绑定项的对象。')
  }

  const bindings: Record<string, SettingBinding> = Object.create(null)
  const boundPaths: Array<{ pointer: string; segments: string[] }> = []
  for (const [pointer, rawBinding] of Object.entries(object.bindings as Record<string, unknown>)) {
    const segments = parsePointer(pointer)
    if (!segments) return error('invalid-json-pointer', `绑定路径 ${pointer} 不是合法 JSON Pointer。`)
    if (pointerGet(object.entryTemplate as JsonValue, segments) === undefined) {
      return error('missing-json-pointer-target', `绑定路径 ${pointer} 未指向模板中已存在的位置。`)
    }
    const result = bindingFor(rawBinding, pointer)
    if (!result.ok) return result
    bindings[pointer] = result.value
    boundPaths.push({ pointer, segments })
  }
  for (let i = 0; i < boundPaths.length; i++) {
    for (let j = i + 1; j < boundPaths.length; j++) {
      if (pathIsPrefix(boundPaths[i].segments, boundPaths[j].segments) || pathIsPrefix(boundPaths[j].segments, boundPaths[i].segments)) {
        return error('overlapping-json-pointers', `绑定路径 ${boundPaths[i].pointer} 与 ${boundPaths[j].pointer} 存在祖先或子孙重叠。`)
      }
    }
  }

  return {
    ok: true,
    value: {
      version: 1,
      theme: object.theme,
      providers: ['manual'],
      entryTemplate: object.entryTemplate,
      bindings
    }
  }
}

export function instantiateTemplate(
  settings: AppSettings,
  context: TemplateContext,
  manualValues: ManualValues = {}
): CoreResult<JsonValue> {
  let value = cloneJson(settings.entryTemplate)
  let serializedSettings: string | undefined
  try { serializedSettings = JSON.stringify(settings) } catch { return error('invalid-settings', '当前设置无法转换为 JSON。') }
  if (typeof serializedSettings !== 'string') return error('invalid-settings', '当前设置无法转换为 JSON。')
  const parsedBindings = parseSettings(serializedSettings)
  if (!parsedBindings.ok) return parsedBindings
  for (const [pointer, binding] of Object.entries(parsedBindings.value.bindings)) {
    const segments = parsePointer(pointer)!
    let replacement: JsonValue | undefined
    if (binding.from === 'selected' || binding.from === 'lemma' || binding.from === 'sentence') {
      replacement = context[binding.from]
    } else if (binding.from === 'constant') {
      replacement = binding.value
    } else if (binding.from === 'manual') {
      replacement = manualValues[pointer]
      if (replacement === undefined) {
        if (binding.required) return error('missing-manual-value', `${binding.label ?? pointer} 是必填项。`)
        continue
      }
      if (binding.required && (typeof replacement !== 'string' || replacement.trim() === '')) {
        return error('missing-manual-value', `${binding.label ?? pointer} 不能为空。`)
      }
    } else {
      return error('invalid-binding', `绑定路径 ${pointer} 的来源无效。`)
    }
    if (replacement === undefined) continue
    value = pointerSet(value, segments, replacement)
  }
  return { ok: true, value }
}

export type SettingsError = CoreError
