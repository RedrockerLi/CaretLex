export const menuCommands = ['new', 'open', 'save', 'save-as', 'export', 'close-tab', 'read-mode', 'source-mode', 'settings', 'toggle-theme', 'undo', 'redo'] as const
export type MenuCommand = typeof menuCommands[number]

export interface MenuState {
  canManageFiles: boolean
  canSave: boolean
  canSaveAs: boolean
  canExport: boolean
  canCloseTab: boolean
  canSwitchMode: boolean
  canOpenSettings: boolean
  canToggleTheme: boolean
  mode: 'read' | 'source' | null
}

export const initialMenuState: MenuState = {
  canManageFiles: false, canSave: false, canSaveAs: false, canExport: false,
  canCloseTab: false, canSwitchMode: false, canOpenSettings: false, canToggleTheme: false, mode: null
}

export function isMenuState(value: unknown): value is MenuState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  return Object.keys(initialMenuState).every(key => key === 'mode'
    ? state.mode === null || state.mode === 'read' || state.mode === 'source'
    : typeof state[key] === 'boolean')
}
