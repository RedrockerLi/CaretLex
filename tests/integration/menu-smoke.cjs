const assert = require('node:assert/strict')
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { app, BrowserWindow, dialog, Menu } = require('electron')

const root = mkdtempSync(join(tmpdir(), 'caretlex-menu-smoke-'))
const dataHome = mkdtempSync(join(tmpdir(), 'caretlex-menu-data-'))
process.env.XDG_DATA_HOME = dataHome
app.setPath('userData', root)
app.setName('caretlex-menu-smoke')
const timeout = setTimeout(() => { console.error('Menu smoke timed out'); app.exit(1) }, 30000)
const saveChoices = []
const openChoices = []
dialog.showSaveDialog = async () => {
  assert.ok(saveChoices.length, 'Unexpected save dialog')
  const filePath = saveChoices.shift()
  return { canceled: filePath === null, filePath: filePath ?? undefined }
}
dialog.showOpenDialog = async () => {
  assert.ok(openChoices.length, 'Unexpected open dialog')
  const filePath = openChoices.shift()
  return { canceled: filePath === null, filePaths: filePath ? [filePath] : [] }
}

const delay = ms => new Promise(done => setTimeout(done, ms))

app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const menu = Menu.getApplicationMenu()
      assert.ok(menu, 'Application menu must exist')
      assert.ok(menu.items.some(item => item.label === '文件'), `Expected Chinese File menu; found: ${menu.items.map(item => item.label).join(', ')}`)
      const ui = expression => window.webContents.executeJavaScript(expression)
      const wait = async (check, label) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (await check()) return
          await delay(25)
        }
        throw new Error(`Timed out: ${label}`)
      }
      const item = id => {
        const value = menu.getMenuItemById(id)
        assert.ok(value, `Missing menu command: ${id}`)
        return value
      }
      const click = id => {
        const value = item(id)
        assert.equal(value.enabled, true, `${id} must be enabled`)
        value.click({}, window, window.webContents)
      }
      const shortcut = (keyCode, modifiers) => {
        window.focus()
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      }
      const clickButton = text => ui(`Array.from(document.querySelectorAll('.dialog-actions button')).find(button => button.textContent === ${JSON.stringify(text)}).click()`)
      const hasModal = () => ui("!!document.querySelector('.confirm-dialog')")
      const source = () => ui("document.querySelector('.cm-content')?.textContent")
      const inspectLabels = items => {
        for (const value of items) {
          if (value.type !== 'separator' && value.label !== 'CaretLex') assert.match(value.label, /[\u4e00-\u9fff]/)
          if (value.submenu) inspectLabels(value.submenu.items)
        }
      }
      inspectLabels(menu.items)
      assert.deepEqual(menu.items.map(value => value.label), ['文件', '编辑', '视图', '窗口', '帮助'])
      assert.equal(item('save').accelerator, 'CmdOrCtrl+S')
      assert.equal(item('save-as').accelerator, 'CmdOrCtrl+Shift+S')
      assert.equal(item('close-tab').accelerator, 'CmdOrCtrl+W')
      await wait(() => item('new').enabled && item('toggle-theme').enabled, 'renderer menu state')
      for (const id of ['save', 'save-as', 'export', 'close-tab', 'read-mode', 'source-mode']) assert.equal(item(id).enabled, false)

      shortcut('N', ['control'])
      await wait(() => ui("document.querySelectorAll('.document-tab').length === 1"), 'new document')
      await wait(() => item('save').enabled, 'unnamed document can be saved')
      assert.equal(item('read-mode').checked, true)
      click('read-mode')
      await delay(50)
      assert.equal(await ui("!!document.querySelector('.source-editor-host')"), false, 'clicking selected mode must not toggle it')
      click('source-mode')
      await wait(() => ui("!!document.querySelector('.cm-content')"), 'source mode')
      await ui("document.querySelector('.cm-content').focus()")
      window.webContents.insertText('# Menu test')
      await wait(() => ui("!!document.querySelector('.dirty-dot')"), 'source edit')
      click('undo')
      await wait(async () => (await source()) === '', 'native Undo in CodeMirror')
      click('redo')
      await wait(async () => (await source()) === '# Menu test', 'native Redo in CodeMirror')

      saveChoices.push(null)
      click('save')
      await wait(() => saveChoices.length === 0 && item('save').enabled, 'cancel save keeps draft')
      assert.equal(await source(), '# Menu test')
      assert.equal(await ui("!!document.querySelector('.dirty-dot')"), true)
      const firstPath = join(root, 'first.md')
      saveChoices.push(firstPath)
      shortcut('S', ['control'])
      await wait(() => ui("!document.querySelector('.dirty-dot') && document.querySelector('.tab-title')?.textContent === 'first.md'"), 'save writes file')
      assert.equal(readFileSync(firstPath, 'utf8'), '# Menu test')
      assert.equal(item('save').enabled, false)

      const secondPath = join(root, 'second.md')
      saveChoices.push(secondPath)
      click('save-as')
      await wait(() => ui("document.querySelector('.tab-title')?.textContent === 'second.md'"), 'save as switches path')
      assert.equal(readFileSync(secondPath, 'utf8'), '# Menu test')
      assert.equal(readFileSync(firstPath, 'utf8'), '# Menu test')

      await ui("document.querySelector('.cm-content').focus()")
      window.webContents.insertText(' changed')
      await wait(() => ui("!!document.querySelector('.dirty-dot')"), 'dirty document')
      click('close-tab')
      await wait(hasModal, 'close dirty tab confirmation')
      await wait(() => !item('new').enabled && !item('save-as').enabled, 'modal disables menu commands')
      await clickButton('取消')
      await wait(async () => !(await hasModal()) && item('read-mode').enabled, 'cancel close')
      click('read-mode')
      await wait(hasModal, 'read mode warns for unsaved source')
      assert.equal(item('source-mode').checked, true, 'pending switch retains accepted mode')
      assert.equal(item('read-mode').checked, false)
      await clickButton('取消')
      await wait(async () => !(await hasModal()) && item('read-mode').enabled, 'cancel switch')
      assert.equal(item('source-mode').checked, true)
      click('read-mode')
      await wait(hasModal, 'repeat switch')
      await clickButton('放弃修改')
      await wait(() => item('read-mode').checked && item('export').enabled, 'discard and switch to read')
      const exportPath = join(root, 'vocabulary.json')
      saveChoices.push(exportPath)
      click('export')
      await wait(() => ui("document.querySelector('.global-message')?.textContent.includes('已导出到')"), 'vocabulary export')
      assert.deepEqual(JSON.parse(readFileSync(exportPath, 'utf8')), {})

      click('settings')
      await wait(() => ui("document.querySelector('.settings-overlay').style.display !== 'none'"), 'settings command')
      await wait(() => !item('save-as').enabled && !item('source-mode').enabled, 'settings disables background document actions')
      const theme = await ui('document.documentElement.dataset.theme')
      click('toggle-theme')
      await wait(async () => (await ui('document.documentElement.dataset.theme')) !== theme, 'theme command')
      const desktopEntry = join(dataHome, 'applications', 'CaretLex.desktop')
      await wait(() => existsSync(desktopEntry), 'the user desktop entry')
      const desktop = readFileSync(desktopEntry, 'utf8')
      assert.match(desktop, /StartupWMClass=CaretLex/)
      assert.match(desktop, /Icon=caretlex/)
      assert.match(desktop, /NoDisplay=true/)
      assert.ok(statSync(join(dataHome, 'icons', 'hicolor', '512x512', 'apps', 'caretlex.png')).size > 0)
      click('settings')
      await wait(() => item('close-tab').enabled, 'the settings command closes the open page')
      click('settings')
      await wait(() => !item('close-tab').enabled, 'the settings command reopens the page')
      const toolbar = label => `Array.from(document.querySelectorAll('.toolbar-button')).find(button => button.textContent === ${JSON.stringify(label)})`
      assert.equal(await ui(`${toolbar('源码')}.disabled`), false, 'the settings page keeps toolbar mode switches usable')
      await ui(`${toolbar('源码')}.click()`)
      await wait(() => ui("!!document.querySelector('.cm-content') && document.querySelector('.settings-overlay').style.display === 'none'"), 'the toolbar leaves the settings page')
      await ui(`${toolbar('阅读')}.click()`)
      await wait(() => item('export').enabled, 'the toolbar returns to the reader')
      await ui("document.querySelector('[aria-label=\"关闭设置\"]').click()")
      await wait(() => item('close-tab').enabled, 'return to document')
      click('close-tab')
      await wait(() => ui("document.querySelectorAll('.document-tab').length === 0"), 'close saved tab')

      const openPath = join(root, 'open.md')
      writeFileSync(openPath, '# Open command\n')
      openChoices.push(openPath)
      click('open')
      await wait(() => ui("document.querySelector('.tab-title')?.textContent === 'open.md'"), 'open command')
      assert.equal(await ui("document.querySelector('.reader-article h1')?.textContent ?? document.querySelector('.document-workspace h1')?.textContent"), 'Open command')
      click('source-mode')
      await wait(() => ui("!!document.querySelector('.cm-content')"), 'edit before quit')
      await ui("document.querySelector('.cm-content').focus()")
      window.webContents.insertText(' unsaved')
      await wait(() => ui("!!document.querySelector('.dirty-dot')"), 'dirty before quit')
      const quit = menu.items.find(value => value.label === '文件').submenu.items.find(value => value.role === 'quit')
      quit.click({}, window, window.webContents)
      await wait(hasModal, 'Quit preserves unsaved document')
      await clickButton('取消')
      await wait(async () => !(await hasModal()), 'cancel Quit')
      assert.equal(window.isDestroyed(), false)
      assert.equal(saveChoices.length, 0)
      assert.equal(openChoices.length, 0)
      console.log('Native menu smoke passed: Chinese labels, commands, real file writes, cancellation, dirty guards, settings, desktop entry and theme')
      clearTimeout(timeout)
      BrowserWindow.getAllWindows().forEach(window => window.destroy())
      rmSync(root, { recursive: true, force: true })
      rmSync(dataHome, { recursive: true, force: true })
      app.exit(0)
    } catch (error) {
      console.error(error)
      clearTimeout(timeout)
      app.exit(1)
    }
  })
})
require(resolve(__dirname, '../../out/main/index.js'))
