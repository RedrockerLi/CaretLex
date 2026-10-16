import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { desktopEntryContents, desktopPaths, ensureLinuxDesktopEntry, xdgDataHome } from '../../src/main/desktop-integration'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'caretlex-desktop-test-')); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir }
const iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('linux desktop entry installation', () => {
  it('writes the hidden entry and icon under the data home, and restores edited files', async () => {
    const home = await temp(); const source = join(await temp(), 'app-icon.png')
    await writeFile(source, iconBytes)
    const paths = await ensureLinuxDesktopEntry({ execPath: '/opt/CaretLex/caretlex', sourceIcon: source, dataHome: home })
    expect(paths).toEqual(desktopPaths(home))
    const entry = await readFile(paths.entry, 'utf8')
    expect(entry).toBe(desktopEntryContents('/opt/CaretLex/caretlex'))
    expect(entry).toContain('Icon=caretlex')
    expect(entry).toContain('StartupWMClass=CaretLex')
    expect(entry).toContain('NoDisplay=true')
    expect(entry).toContain('Exec="/opt/CaretLex/caretlex" %U')
    expect(entry).toContain('MimeType=text/markdown;text/x-markdown;')
    expect(await readFile(paths.icon)).toEqual(iconBytes)
    await writeFile(paths.entry, 'edited')
    await writeFile(paths.icon, Buffer.from([0x00]))
    await ensureLinuxDesktopEntry({ execPath: '/opt/CaretLex/caretlex', sourceIcon: source, dataHome: home })
    expect(await readFile(paths.entry, 'utf8')).toBe(entry)
    expect(await readFile(paths.icon)).toEqual(iconBytes)
  })
  it('reports a missing icon source instead of writing a partial entry', async () => {
    const home = await temp()
    await expect(ensureLinuxDesktopEntry({ execPath: '/opt/CaretLex/caretlex', sourceIcon: join(home, 'missing.png'), dataHome: home }))
      .rejects.toBeInstanceOf(Error)
    await expect(readFile(desktopPaths(home).entry)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('resolves the data home from the environment with an XDG fallback', () => {
    expect(xdgDataHome({ XDG_DATA_HOME: '/tmp/xdg-data' })).toBe('/tmp/xdg-data')
    expect(xdgDataHome({ XDG_DATA_HOME: '   ' })).toBe(join(homedir(), '.local', 'share'))
    expect(xdgDataHome({})).toBe(join(homedir(), '.local', 'share'))
  })
})
