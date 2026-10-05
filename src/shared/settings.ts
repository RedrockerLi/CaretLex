import type { CoreResult, JsonValue } from './types'
import { isJsonValue } from './json'
import { manualTemplate, providerTypes, type ProviderType } from './providers'
import { validateMappingTemplate, renameSource } from './mapping'

export type Theme = 'system' | 'light' | 'dark'
export interface ProviderProfile { name: string; type: string; enabled: boolean; config: JsonValue }
export interface AppSettings { theme: Theme; providers: ProviderProfile[]; saveTemplate: JsonValue }
export const defaultSettings: AppSettings = { theme: 'system', providers: [], saveTemplate: manualTemplate }
export function parseSettings(text: string, types: ReadonlyMap<string, ProviderType> = providerTypes): CoreResult<AppSettings> {
  const fail = (code: string, message: string): CoreResult<never> => ({ ok: false, error: { code, message } })
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fail('invalid-settings-json', '设置文件不是合法 JSON。') }
  if (!isJsonValue(raw) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid-settings', '设置根值必须是 JSON 对象。')
  if (!['system', 'light', 'dark'].includes(String(raw.theme))) return fail('invalid-settings-theme', 'theme 必须是 system、light 或 dark。')
  if (Object.keys(raw).some(key => !['theme', 'providers', 'saveTemplate'].includes(key))) return fail('invalid-settings', '设置含有不支持的字段，请修改完整 JSON 或恢复默认设置。')
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
  if (!Object.hasOwn(raw, 'saveTemplate')) return fail('missing-save-template', '必须提供 saveTemplate。')
  const mapping = validateMappingTemplate(raw.saveTemplate)
  if (!mapping.ok) return mapping
  return { ok: true, value: { theme: raw.theme as Theme, providers: profiles, saveTemplate: raw.saveTemplate } }
}
export function renameProfile(settings: AppSettings, oldName: string, newName: string): AppSettings {
  return { ...settings, providers: settings.providers.map(profile => profile.name === oldName ? { ...profile, name: newName } : profile), saveTemplate: renameSource(settings.saveTemplate, oldName, newName) }
}
