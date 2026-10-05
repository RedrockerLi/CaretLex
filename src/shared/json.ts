import type { JsonValue } from './types'

export function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (seen.has(value) || Object.getOwnPropertySymbols(value).length !== 0) return false
    if (Object.getOwnPropertyNames(value).some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) return false
    if (Object.keys(value).length !== value.length) return false
    if (Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => key !== 'length' && (!descriptor.enumerable || descriptor.get || descriptor.set))) return false
    seen.add(value)
    const valid = value.every((item, index) => index in value && isJsonValue(item, seen))
    seen.delete(value)
    return valid
  }
  if (typeof value === 'object') {
    const object = value as object
    if (seen.has(object)) return false
    const prototype = Object.getPrototypeOf(object)
    if (prototype !== Object.prototype && prototype !== null) return false
    if (Object.getOwnPropertySymbols(object).length !== 0) return false
    seen.add(object)
    const descriptors = Object.getOwnPropertyDescriptors(object)
    const valid = Object.entries(descriptors).every(([key, descriptor]) =>
      descriptor.enumerable && !descriptor.get && !descriptor.set && isJsonValue((value as Record<string, unknown>)[key], seen)
    )
    seen.delete(object)
    return valid
  }
  return false
}

export function serializeJsonValue(value: unknown): string | undefined {
  try {
    if (!isJsonValue(value)) return undefined
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : undefined
  } catch {
    return undefined
  }
}

export function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
