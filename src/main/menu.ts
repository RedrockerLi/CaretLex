import type { Menu, MenuItemConstructorOptions } from 'electron'
import type { MenuCommand, MenuState } from '../shared/menu'

export function applicationMenuTemplate(options: {
  isMac: boolean
  development: boolean
  command: (command: MenuCommand) => void
  about: () => void
}): MenuItemConstructorOptions[] {
  const command = (id: MenuCommand, label: string, accelerator?: string): MenuItemConstructorOptions => ({
    id, label, accelerator, enabled: id === 'undo' || id === 'redo', click: () => options.command(id)
  })
  const separator: MenuItemConstructorOptions = { type: 'separator' }
  const about: MenuItemConstructorOptions = { label: '关于 CaretLex', click: options.about }
  const settings = () => command('settings', '设置…', 'CmdOrCtrl+,')
  const quit: MenuItemConstructorOptions = { label: '退出', role: 'quit', accelerator: 'CmdOrCtrl+Q' }
  return [
    ...(options.isMac ? [{ label: 'CaretLex', submenu: [
      about, separator, settings(), separator,
      { label: '服务', role: 'services' as const }, separator,
      { label: '隐藏 CaretLex', role: 'hide' as const },
      { label: '隐藏其他应用', role: 'hideOthers' as const },
      { label: '显示全部', role: 'unhide' as const }, separator, quit
    ] }] : []),
    { label: '文件', submenu: [
      command('new', '新建文档', 'CmdOrCtrl+N'),
      command('open', '打开 Markdown…', 'CmdOrCtrl+O'), separator,
      command('save', '保存', 'CmdOrCtrl+S'),
      command('save-as', '另存为…', 'CmdOrCtrl+Shift+S'), separator,
      command('export', '导出词条 JSON…'), separator,
      command('close-tab', '关闭标签页', 'CmdOrCtrl+W'),
      ...(!options.isMac ? [separator, settings(), separator, quit] : [])
    ] },
    { label: '编辑', submenu: [
      command('undo', '撤销', 'CmdOrCtrl+Z'),
      command('redo', '重做', options.isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y'), separator,
      { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' }, { label: '粘贴为纯文本', role: 'pasteAndMatchStyle' },
      { label: '删除', role: 'delete' }, separator, { label: '全选', role: 'selectAll' }
    ] },
    { label: '视图', submenu: [
      { ...command('read-mode', '阅读模式', 'CmdOrCtrl+Shift+R'), type: 'checkbox' },
      { ...command('source-mode', '源码模式', 'CmdOrCtrl+Shift+E'), type: 'checkbox' }, separator,
      command('toggle-theme', '切换深色／浅色主题'), separator,
      { label: '实际大小', role: 'resetZoom' }, { label: '放大', role: 'zoomIn' },
      { label: '缩小', role: 'zoomOut' }, separator, { label: '切换全屏', role: 'togglefullscreen' },
      ...(options.development ? [separator, { label: '开发者工具', role: 'toggleDevTools' as const }] : [])
    ] },
    { label: '窗口', submenu: [
      { label: '最小化', role: 'minimize' },
      { label: '缩放窗口', role: 'zoom' },
      ...(options.isMac ? [separator, { label: '全部置于前台', role: 'front' as const }] : [])
    ] },
    { label: '帮助', submenu: [about] }
  ]
}

export function updateApplicationMenu(menu: Menu, state: MenuState): void {
  const enabled: Record<Exclude<MenuCommand, 'undo' | 'redo'>, boolean> = {
    new: state.canManageFiles, open: state.canManageFiles, save: state.canSave,
    'save-as': state.canSaveAs, export: state.canExport, 'close-tab': state.canCloseTab,
    'read-mode': state.canSwitchMode, 'source-mode': state.canSwitchMode,
    settings: state.canOpenSettings, 'toggle-theme': state.canToggleTheme
  }
  for (const [id, value] of Object.entries(enabled)) {
    const item = menu.getMenuItemById(id)
    if (item) item.enabled = value
  }
  const read = menu.getMenuItemById('read-mode')
  const source = menu.getMenuItemById('source-mode')
  if (read) read.checked = state.mode === 'read'
  if (source) source.checked = state.mode === 'source'
}
