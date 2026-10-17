import type { CoreResult, JsonValue } from './types'
import { cloneJson, isJsonValue } from './json'
import {
  defaultDictionaryPrompt, defaultDictionaryResponse, defaultPrompt, dictionaryPresetCompatibility,
  legacyDefaultPrompt, manualTemplate, presetCompatibility, providerTypes, validateExample, type ProviderType
} from './providers'
import { validateMappingTemplate, renameSource } from './mapping'

export type Theme = 'system' | 'light' | 'dark'
export interface ProviderProfile { name: string; type: string; enabled: boolean; config: JsonValue }
export interface DictionarySettings { enabled: boolean; apiKeyRef?: string; timeoutMs: number; responseTemplate: JsonValue }
export interface AppSettings { theme: Theme; providers: ProviderProfile[]; saveTemplate: JsonValue; quickAdd: boolean; dictionary: DictionarySettings }
export const defaultSettings: AppSettings = {
  theme: 'system', providers: [], saveTemplate: manualTemplate, quickAdd: false,
  dictionary: { enabled: false, timeoutMs: 10000, responseTemplate: defaultDictionaryResponse }
}
const apiKeyRefPattern = /^key-[a-f0-9-]{36}$/
function parseDictionary(value: unknown): CoreResult<DictionarySettings> {
  const fail = (code: string, message: string): CoreResult<never> => ({ ok: false, error: { code, message } })
  if (value === undefined) return { ok: true, value: cloneJson(defaultSettings.dictionary) }
  if (!isJsonValue(value) || !value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid-dictionary', 'dictionary 必须是 JSON 对象。')
  if (Object.keys(value).some(key => !['enabled', 'apiKeyRef', 'timeoutMs', 'responseTemplate'].includes(key))) return fail('invalid-dictionary', 'dictionary 含有不支持的字段。')
  const record = value as Record<string, JsonValue>
  const enabled = record.enabled ?? false
  if (typeof enabled !== 'boolean') return fail('invalid-dictionary', 'dictionary.enabled 必须为布尔值。')
  const timeoutMs = record.timeoutMs ?? 10000
  if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 2147483647) return fail('invalid-dictionary', 'dictionary.timeoutMs 必须为 1–2147483647 的整数。')
  const apiKeyRef = record.apiKeyRef
  if (apiKeyRef !== undefined && (typeof apiKeyRef !== 'string' || !apiKeyRefPattern.test(apiKeyRef))) return fail('invalid-dictionary', 'dictionary.apiKeyRef 格式无效。')
  const responseTemplate = record.responseTemplate ?? cloneJson(defaultDictionaryResponse)
  const example = validateExample(responseTemplate)
  if (!example.ok) return example
  const compatible = dictionaryPresetCompatibility(responseTemplate)
  if (compatible) return fail('invalid-dictionary', compatible)
  return { ok: true, value: { enabled, timeoutMs: Number(timeoutMs), ...(apiKeyRef ? { apiKeyRef } : {}), responseTemplate } }
}
export function parseSettings(text: string, types: ReadonlyMap<string, ProviderType> = providerTypes): CoreResult<AppSettings> {
  const fail = (code: string, message: string): CoreResult<never> => ({ ok: false, error: { code, message } })
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fail('invalid-settings-json', '设置文件不是合法 JSON。') }
  if (!isJsonValue(raw) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid-settings', '设置根值必须是 JSON 对象。')
  if (!['system', 'light', 'dark'].includes(String(raw.theme))) return fail('invalid-settings-theme', 'theme 必须是 system、light 或 dark。')
  if (Object.keys(raw).some(key => !['theme', 'providers', 'saveTemplate', 'quickAdd', 'dictionary'].includes(key))) return fail('invalid-settings', '设置含有不支持的字段，请修改完整 JSON 或恢复默认设置。')
  if (raw.quickAdd !== undefined && typeof raw.quickAdd !== 'boolean') return fail('invalid-settings', 'quickAdd 必须为布尔值。')
  const dictionary = parseDictionary(raw.dictionary)
  if (!dictionary.ok) return dictionary
  if (!Array.isArray(raw.providers)) return fail('invalid-settings-providers', 'providers 必须为实例数组。')
  const names = new Set<string>()
  const profiles: ProviderProfile[] = []
  for (const profile of raw.providers) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).some(key => !['name', 'type', 'enabled', 'config'].includes(key))) return fail('invalid-provider', 'provider 实例格式无效。')
    if (typeof profile.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(profile.name) || profile.name === 'article' || names.has(profile.name)) return fail('invalid-provider-name', 'name 必须是唯一可引用标识，article 是保留名。')
    names.add(profile.name)
    if (typeof profile.type !== 'string' || !types.has(profile.type)) return fail('unknown-provider-type', `未注册 provider type：${profile.type}`)
    if (typeof profile.enabled !== 'boolean') return fail('invalid-provider', 'enabled 必须为布尔值。')
    const config = types.get(profile.type)!.validateConfig(profile.config, profile.enabled)
    if (!config.ok) return config
    profiles.push({ name: profile.name, type: profile.type, enabled: profile.enabled, config: config.value })
  }
  if (profiles.filter(profile => profile.enabled).length > 1) return fail('multiple-active-providers', '一次最多启用一个 provider 实例。')
  const enabledProfile = profiles.find(profile => profile.enabled)
  if (enabledProfile?.type === 'LLM') {
    const config = enabledProfile.config
    if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.prompt !== 'string') return fail('invalid-llm-config', 'LLM config 缺少 Prompt。')
    const promptConfig = config as Record<string, JsonValue>
    if (dictionary.value.enabled) {
      if (promptConfig.prompt === defaultPrompt || promptConfig.prompt === legacyDefaultPrompt) promptConfig.prompt = defaultDictionaryPrompt
      if (typeof promptConfig.prompt !== 'string' || !promptConfig.prompt.includes('{{dictionary}}')) return fail('dictionary-prompt-missing', '启用词典增强后，已启用 LLM 的 Prompt 必须包含 {{dictionary}}。')
      const reason = presetCompatibility(config)
      if (reason) return fail('dictionary-response-template-incompatible', `启用词典增强要求响应示例包含默认字段：${reason}`)
    } else {
      if (promptConfig.prompt === defaultDictionaryPrompt) promptConfig.prompt = defaultPrompt
      if (typeof promptConfig.prompt === 'string' && promptConfig.prompt.includes('{{dictionary}}')) return fail('dictionary-prompt-unexpected', '词典增强未启用时，Prompt 不能包含 {{dictionary}}。')
    }
  }
  if (!Object.hasOwn(raw, 'saveTemplate')) return fail('missing-save-template', '必须提供 saveTemplate。')
  const mapping = validateMappingTemplate(raw.saveTemplate)
  if (!mapping.ok) return mapping
  return { ok: true, value: { theme: raw.theme as Theme, providers: profiles, saveTemplate: raw.saveTemplate, quickAdd: raw.quickAdd === true, dictionary: dictionary.value } }
}
export function renameProfile(settings: AppSettings, oldName: string, newName: string): AppSettings {
  return { ...settings, providers: settings.providers.map(profile => profile.name === oldName ? { ...profile, name: newName } : profile), saveTemplate: renameSource(settings.saveTemplate, oldName, newName) }
}
