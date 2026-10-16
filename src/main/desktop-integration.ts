import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface DesktopEntryPaths { entry: string; icon: string }

/** 用户级 XDG 位置：任务栏图标与启动菜单共用同一套 .desktop 约定。 */
export function xdgDataHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
}

export function desktopPaths(dataHome: string): DesktopEntryPaths {
  return {
    entry: join(dataHome, 'applications', 'CaretLex.desktop'),
    icon: join(dataHome, 'icons', 'hicolor', '512x512', 'apps', 'caretlex.png'),
  }
}

/** 与 deb/AppImage 产物同名同 WMClass，NoDisplay 让条目只用于 app_id 匹配，不进入启动菜单。 */
export function desktopEntryContents(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=CaretLex',
    'Comment=English Markdown reader with document-local vocabulary notes',
    `Exec="${execPath}" %U`,
    'Icon=caretlex',
    'Terminal=false',
    'Categories=Office;',
    'MimeType=text/markdown;text/x-markdown;',
    'StartupWMClass=CaretLex',
    'NoDisplay=true',
    '',
  ].join('\n')
}

async function writeIfChanged(path: string, contents: Buffer): Promise<boolean> {
  try {
    if ((await readFile(path)).equals(contents)) return false
  } catch { /* 缺失或不可读：按需要写入 */ }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, { mode: 0o644 })
  return true
}

export async function ensureLinuxDesktopEntry(options: { execPath: string; sourceIcon: string; dataHome: string }): Promise<DesktopEntryPaths> {
  const paths = desktopPaths(options.dataHome)
  await writeIfChanged(paths.icon, await readFile(options.sourceIcon))
  await writeIfChanged(paths.entry, Buffer.from(desktopEntryContents(options.execPath)))
  return paths
}
