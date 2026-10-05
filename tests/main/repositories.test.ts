import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalSavePath, CaretLexError, DocumentRepository, SettingsRepository, revision } from '../../src/main/repositories'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const directories: string[] = []

async function tempDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'caretlex-test-'))
  directories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('document repository', () => {
  it('rejects oversized reads and writes without truncating or changing disk bytes', async () => {
    const dir = await tempDirectory()
    const path = join(dir, 'book.md')
    const repository = new DocumentRepository()
    const large = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61)
    await writeFile(path, large)
    await expect(repository.open(path)).rejects.toMatchObject({ code: 'TOO_LARGE' })
    expect(repository.getOpenPaths()).toEqual([])
    expect(revision(await readFile(path))).toBe(revision(large))
    await writeFile(path, 'original\n')
    const opened = await repository.open(path)
    await expect(repository.saveSource(opened.snapshot.id, large.toString('utf8'), opened.snapshot.revision)).rejects.toMatchObject({ code: 'TOO_LARGE' })
    expect(await readFile(path, 'utf8')).toBe('original\n')
    await repository.close(opened.snapshot.id)
  })

  it('rejects a trailing unmatched UTF-16 surrogate instead of writing replacement bytes', async () => {
    const dir = await tempDirectory()
    const path = join(dir, 'book.md')
    await writeFile(path, 'original\n')
    const repository = new DocumentRepository()
    const opened = await repository.open(path)
    await expect(repository.saveSource(opened.snapshot.id, 'draft\ud800', opened.snapshot.revision)).rejects.toMatchObject({ code: 'INVALID_TEXT' })
    expect(await readFile(path, 'utf8')).toBe('original\n')
    await repository.close(opened.snapshot.id)
  })

  it('preserves a content U+FEFF after the file BOM byte sequence', async () => {
    const dir = await tempDirectory()
    const path = join(dir, 'book.md')
    const original = Buffer.concat([BOM, BOM, Buffer.from('# Title\r\n')])
    await writeFile(path, original)

    const repository = new DocumentRepository()
    const opened = await repository.open(path)
    expect(opened.snapshot.bom).toBe(true)
    expect(opened.snapshot.text).toBe('\uFEFF# Title\r\n')
    await repository.saveSource(opened.snapshot.id, opened.snapshot.text, opened.snapshot.revision)
    expect(await readFile(path)).toEqual(original)
    await repository.close(opened.snapshot.id)
  })

  it('requires the loaded revision and serializes two writes to the same document', async () => {
    const dir = await tempDirectory()
    const path = join(dir, 'book.md')
    await writeFile(path, 'original\n')
    const repository = new DocumentRepository()
    const opened = await repository.open(path)

    await expect(repository.saveSource(opened.snapshot.id, 'missing revision\n')).rejects.toMatchObject({ code: 'REVISION_REQUIRED' })
    const writes = await Promise.allSettled([
      repository.saveSource(opened.snapshot.id, 'first\n', opened.snapshot.revision),
      repository.saveSource(opened.snapshot.id, 'second\n', opened.snapshot.revision),
    ])
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const disk = await readFile(path, 'utf8')
    expect(['first\n', 'second\n']).toContain(disk)
    await repository.close(opened.snapshot.id)
  })

  it('deduplicates concurrent opens and rejects invalid UTF-8 without modifying the file', async () => {
    const dir = await tempDirectory()
    const path = join(dir, 'book.md')
    await writeFile(path, 'a\n')
    const repository = new DocumentRepository()
    const [first, second] = await Promise.all([repository.open(path), repository.open(path)])
    expect(second.snapshot.id).toBe(first.snapshot.id)
    await repository.close(first.snapshot.id)

    const invalid = join(dir, 'invalid.md')
    const bytes = Buffer.from([0xc3, 0x28])
    await writeFile(invalid, bytes)
    await expect(repository.open(invalid)).rejects.toMatchObject({ code: 'ENCODING' })
    expect(await readFile(invalid)).toEqual(bytes)
  })

  it('allows only local images whose opened file stays under the document directory', async () => {
    const dir = await tempDirectory()
    const docs = join(dir, 'docs')
    const outside = join(dir, 'outside.png')
    await mkdir(docs)
    const imageBytes = Buffer.from([1, 2, 3, 4])
    await writeFile(join(docs, 'safe.png'), imageBytes)
    await writeFile(outside, Buffer.from([5, 6, 7]))
    await symlink(outside, join(docs, 'escape.png'))
    const path = join(docs, 'book.md')
    await writeFile(path, 'text\n')
    const repository = new DocumentRepository()
    const opened = await repository.open(path)

    await expect(repository.resolveLocalImage(opened.snapshot.id, 'safe.png')).resolves.toEqual({ bytes: imageBytes, mime: 'image/png' })
    await expect(repository.resolveLocalImage(opened.snapshot.id, '../outside.png')).resolves.toBeNull()
    await expect(repository.resolveLocalImage(opened.snapshot.id, 'escape.png')).resolves.toBeNull()
    await repository.close(opened.snapshot.id)
  })

  it('canonicalizes export path aliases without changing the selected output path', async () => {
    const dir = await tempDirectory()
    const document = join(dir, 'book.md')
    const alias = join(dir, 'book-link.md')
    await writeFile(document, '# Book\n')
    await symlink(document, alias)

    await expect(canonicalSavePath(alias)).resolves.toBe(document)
  })
})

describe('settings repository', () => {
  it('rejects oversized settings without replacing their bytes', async () => {
    const dir = await tempDirectory()
    const repository = new SettingsRepository(dir)
    const initial = await repository.load()
    await expect(repository.save({ ...initial.value, saveTemplate: '字'.repeat(400000) }, initial.revision)).rejects.toMatchObject({ code: 'SETTINGS_INVALID' })
    const path = join(dir, 'settings.json')
    const large = Buffer.alloc(1024 * 1024 + 1, 0x61)
    await writeFile(path, large)
    const loaded = await repository.load()
    expect(loaded.error).toContain('1 MiB')
    expect(loaded.text).toBeUndefined()
    await expect(repository.save(initial.value, loaded.revision)).rejects.toMatchObject({ code: 'SETTINGS_INVALID' })
    expect(revision(await readFile(path))).toBe(revision(large))
  })

  it('does not replace a corrupt file with defaults', async () => {
    const dir = await tempDirectory()
    const path = join(dir, 'settings.json')
    const bytes = Buffer.from('{bad json\n')
    await writeFile(path, bytes)
    const repository = new SettingsRepository(dir)

    const loaded = await repository.load()
    expect(loaded).toMatchObject({ text: bytes.toString('utf8'), error: expect.any(String) })
    expect(loaded.value).toBeUndefined()
    expect(await readFile(path)).toEqual(bytes)
  })

  it('serializes updates and prevents stale settings saves', async () => {
    const dir = await tempDirectory()
    const repository = new SettingsRepository(dir)
    const initial = await repository.load()
    const results = await Promise.allSettled([
      repository.save({ ...initial.value, theme: 'dark' }, initial.revision),
      repository.save({ ...initial.value, theme: 'light' }, initial.revision),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const current = await repository.load()
    expect(['dark', 'light']).toContain(current.value!.theme)
  })

  it('rejects migration to the local settings path pointer', async () => {
    const dir = await tempDirectory()
    const repository = new SettingsRepository(dir)
    await repository.load()
    const pointer = join(dir, 'settings-path.json')
    await expect(repository.migrateTo(pointer)).rejects.toMatchObject({ code: 'SETTINGS_PATH_RESERVED' })
    const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as { providers: unknown[] }
    expect(settings.providers).toEqual([]); expect(settings).not.toHaveProperty('version')
    await expect(readFile(pointer)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('migrates settings to a sync path and restores that path from the local pointer', async () => {
    const userData = await tempDirectory()
    const syncDirectory = await tempDirectory()
    const repository = new SettingsRepository(userData)
    const initial = await repository.load()
    const target = join(syncDirectory, 'caretlex-settings.json')

    const migrated = await repository.migrateTo(target)

    expect(migrated.path).toBe(target)
    expect(migrated.value).toEqual(initial.value)
    expect(JSON.parse(await readFile(join(userData, 'settings-path.json'), 'utf8'))).toEqual({ path: target })
    await expect(readFile(join(userData, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const reopened = await new SettingsRepository(userData).load()
    expect(reopened.path).toBe(target)
    expect(reopened.value).toEqual(initial.value)
  })
})

describe('explicit default settings recovery', () => {
  it.each([
    Buffer.from('{bad JSON'), Buffer.from('{"version":2}'), Buffer.from([0xc3, 0x28]), Buffer.alloc(1024 * 1024 + 1, 0x61)
  ])('preserves invalid bytes until the default settings action, then persists a parseable configuration', async bytes => {
    const dir = await tempDirectory(); const path = join(dir, 'settings.json')
    const credentials = Buffer.from('{"local":"secret"}')
    await writeFile(path, bytes); await writeFile(join(dir, 'credentials.json'), credentials)
    const repository = new SettingsRepository(dir); const loaded = await repository.load()
    expect(loaded.value).toBeUndefined(); expect(loaded.error).toBeTruthy(); expect(loaded.resetToken).toBeTruthy()
    expect(await readFile(path)).toEqual(bytes)
    const saved = await repository.resetDefaults(loaded.resetToken!)
    expect(saved.error).toBeUndefined(); expect(saved.value).toMatchObject({ theme: 'system', providers: [] })
    const disk = JSON.parse(await readFile(path, 'utf8'))
    expect(disk).toEqual(saved.value); expect(disk).not.toHaveProperty('version')
    expect((await new SettingsRepository(dir).load()).value).toEqual(disk)
    expect(await readFile(join(dir, 'credentials.json'))).toEqual(credentials)
  })
  it('repairs a damaged path pointer without interpreting it as a destination', async () => {
    const dir = await tempDirectory(); const pointer = join(dir, 'settings-path.json')
    await writeFile(pointer, '{bad pointer')
    const repository = new SettingsRepository(dir); const loaded = await repository.load()
    expect(loaded.error).toContain('指针'); expect(loaded.resetToken).toBeTruthy()
    const saved = await repository.resetDefaults(loaded.resetToken!)
    expect(saved.error).toBeUndefined(); expect(JSON.parse(await readFile(pointer, 'utf8'))).toEqual({ path: join(dir, 'settings.json') })
    expect((await new SettingsRepository(dir).load()).value).toEqual(saved.value)
  })
  it('rejects stale reset requests after file or pointer changes', async () => {
    const dir = await tempDirectory(); const repository = new SettingsRepository(dir)
    const initial = await repository.load(); const changed = '{externally changed}'
    await writeFile(initial.path, changed)
    await expect(repository.resetDefaults(initial.resetToken!)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await readFile(initial.path, 'utf8')).toBe(changed)
    const next = await repository.load(); const pointer = join(dir, 'settings-path.json')
    await writeFile(pointer, '{changed pointer}')
    await expect(repository.resetDefaults(next.resetToken!)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await readFile(pointer, 'utf8')).toBe('{changed pointer}'); expect(await readFile(initial.path, 'utf8')).toBe(changed)
  })
  it('can restore defaults when a loaded settings file disappears', async () => {
    const dir = await tempDirectory(); const repository = new SettingsRepository(dir)
    const initial = await repository.load(); await rm(initial.path)
    const missing = await repository.load(); expect(missing.error).toBeTruthy(); expect(missing.resetToken).toBeTruthy()
    const restored = await repository.resetDefaults(missing.resetToken!)
    expect(restored.error).toBeUndefined(); expect(restored.value?.providers).toEqual([])
  })
})
