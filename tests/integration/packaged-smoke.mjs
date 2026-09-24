import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'undici'

const binary = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: node tests/integration/packaged-smoke.mjs <linux-unpacked-binary-or-appimage>')

const root = await mkdtemp(join(tmpdir(), 'caretlex-packaged-smoke-'))
const filePath = join(root, 'reader.md')
const original = '# Reading\n\nShe went home. She went again.\n'
await writeFile(filePath, original, 'utf8')

const portServer = createServer()
await new Promise((resolveListen, rejectListen) => {
  portServer.once('error', rejectListen)
  portServer.listen(0, '127.0.0.1', resolveListen)
})
const port = portServer.address().port
await new Promise((resolveClose, rejectClose) => portServer.close((error) => error ? rejectClose(error) : resolveClose()))

const isAppImage = binary.endsWith('.AppImage')
const appArgs = [
  ...(isAppImage ? ['--appimage-extract-and-run'] : []),
  '--no-sandbox',
  '--disable-gpu',
  `--remote-debugging-port=${port}`,
  filePath,
]
const environment = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
}

let child
let socket
let nextId = 1
let passed = false
const pending = new Map()
let stderr = ''

function startApp() {
  child = spawn(binary, appArgs, { env: environment, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000) })
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) stderr = `${stderr}\nElectron exited with code ${code} (${signal ?? ''}).`
  })
}

async function waitForTarget() {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Electron exited before opening its window.\n${stderr}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch { /* Wait for Chromium's debugging endpoint. */ }
    await delay(200)
  }
  throw new Error(`Timed out waiting for the Electron window.\n${stderr}`)
}

async function connect() {
  const url = await waitForTarget()
  socket = new WebSocket(url)
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data.toString())
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id)
      pending.delete(message.id)
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result)
    }
  })
  await send('Runtime.enable')
  await send('Page.enable')
}

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolveMessage, rejectMessage) => {
    pending.set(id, { resolve: resolveMessage, reject: rejectMessage })
    socket.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      rejectMessage(new Error(`Timed out waiting for CDP ${method}.`))
    }, 10000).unref()
  })
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text)
  return response.result?.value
}

async function waitUi(expression, description, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await evaluate(expression)) return
    await delay(100)
  }
  const pageState = await evaluate(`JSON.stringify({ title: document.title, readyState: document.readyState, text: document.body?.innerText?.slice(0, 1200), html: document.querySelector('#app')?.innerHTML?.slice(0, 1500) })`).catch((error) => String(error))
  const formState = await evaluate(`JSON.stringify({ lemma: document.querySelector('#lemma-input')?.value, translation: document.querySelector('#translation-input')?.value, saveDisabled: document.querySelector('.composer-actions .button-primary')?.disabled, saveText: document.querySelector('.composer-actions .button-primary')?.textContent, error: [...document.querySelectorAll('.global-message')].map((element) => element.innerText) })`).catch((error) => String(error))
  throw new Error(`Timed out waiting for ${description}. Page state: ${pageState}\nForm state: ${formState}\n${stderr}`)
}

async function selectVisibleWord(occurrence) {
  const result = await evaluate(`(() => {
    const root = document.querySelector('.reader-scroll');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let found = 0;
    let node;
    while ((node = walker.nextNode())) {
      let start = 0;
      while ((start = node.nodeValue.indexOf('went', start)) >= 0) {
        if (found++ === ${occurrence}) {
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + 4);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return selection.toString();
        }
        start += 4;
      }
    }
    return null;
  })()`)
  assert.equal(result, 'went', `Selection ${occurrence} could not be made from the rendered DOM.`)
  await waitUi("!!document.querySelector('.selection-toolbar')", 'the selection toolbar')
}

async function addWord(occurrence, translation) {
  await selectVisibleWord(occurrence)
  await evaluate("document.querySelector('.selection-toolbar button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))")
  await waitUi("!!document.querySelector('.entry-composer')", 'the manual entry composer')
  await evaluate(`(() => {
    const set = (selector, value) => {
      const element = document.querySelector(selector);
      const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value').set;
      setter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#lemma-input', 'go');
    const translation = document.querySelector('#translation-input');
    if (translation) set('#translation-input', ${JSON.stringify(translation)});
  })()`)
  await waitUi("document.querySelector('.composer-actions .button-primary')?.disabled === false", 'a valid vocabulary entry')
  await evaluate("document.querySelector('.composer-actions .button-primary').click()")
}

async function waitForFile(predicate, description) {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const current = await readFile(filePath, 'utf8')
    if (predicate(current)) return current
    await delay(100)
  }
  const pageState = socket ? await evaluate(`JSON.stringify({ text: document.body?.innerText?.slice(0, 1800), composer: document.querySelector('.entry-composer')?.innerText, lemma: document.querySelector('#lemma-input')?.value, translation: document.querySelector('#translation-input')?.value })`).catch((error) => String(error)) : ''
  throw new Error(`Timed out waiting for ${description}. Current document:\n${await readFile(filePath, 'utf8')}\nPage state: ${pageState}\n${stderr}`)
}

async function stopApp() {
  if (socket) {
    try { socket.close() } catch { /* Already closed. */ }
    socket = undefined
  }
  if (child && child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      delay(5000),
    ])
    try { process.kill(-child.pid, 'SIGKILL') } catch { if (child.exitCode === null) child.kill('SIGKILL') }
  }
  child = undefined
}

try {
  startApp()
  await connect()
  await waitUi("document.readyState === 'complete' && !!document.querySelector('.reader-scroll')", 'the rendered Markdown document')

  await addWord(1, '去')
  let current = await waitForFile((text) => text.includes('went[^w-go] again.') && text.includes('"translation":"去"'), 'saving a word at the selected repeated occurrence')
  assert.equal((current.match(/went\[\^w-go\]/g) ?? []).length, 1, 'The first save should affect only the selected occurrence.')
  await waitUi("document.querySelectorAll('.vocab-anchor').length === 1", 'rendering the saved vocabulary reference')

  await addWord(0, '')
  current = await waitForFile((text) => (text.match(/\[\^w-go\]/g) ?? []).length === 3, 'reusing an existing lemma at another occurrence')
  const noOpBaseline = await readFile(filePath)
  await addWord(0, '')
  await delay(350)
  assert.deepEqual(await readFile(filePath), noOpBaseline, 'Repeating a saved word at the same position must not change file bytes.')

  await evaluate("document.querySelector('.vocab-anchor')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))")
  await waitUi("!!document.querySelector('.vocab-card')", 'the hover card')
  await evaluate("[...document.querySelectorAll('.vocab-card button')].find(button => button.textContent.trim() === '编辑').click()")
  await waitUi("!!document.querySelector('.vocab-card textarea')", 'the editable vocabulary JSON')
  await evaluate(`(() => {
    const textarea = document.querySelector('.vocab-card textarea');
    const value = JSON.parse(textarea.value);
    value.translation = '离开';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, JSON.stringify(value, null, 2));
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.vocab-card button')].find(button => button.textContent.trim() === '保存修改').click();
  })()`)
  await waitForFile((text) => text.includes('"translation":"离开"'), 'editing the vocabulary value')

  await evaluate("document.querySelector('.vocab-anchor')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))")
  await waitUi("!!document.querySelector('.vocab-card')", 'the refreshed hover card after editing')
  await evaluate("[...document.querySelectorAll('.vocab-card button')].find(button => button.textContent.trim() === '删除').click()")
  await evaluate("[...document.querySelectorAll('.vocab-card button')].find(button => button.textContent.trim() === '确认删除').click()")
  current = await waitForFile((text) => !text.includes('[^w-go]') && text.includes('<!-- caretlex:vocab:end -->'), 'deleting all references and its managed definition')
  assert.match(current, /She went home\. She went again\./)

  await addWord(0, '去')
  current = await waitForFile((text) => text.includes('went[^w-go] home.') && text.includes('"translation":"去"'), 'saving a vocabulary entry for persistence')

  await evaluate("[...document.querySelectorAll('.toolbar-button')].find(button => button.textContent.trim() === '源码').click()")
  await waitUi("document.querySelector('.cm-content')?.isContentEditable === true", 'the CodeMirror source editor')
  await evaluate(`(() => {
    const editor = document.querySelector('.cm-content');
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`)
  await send('Input.insertText', { text: '\nEdited from packaged source mode.\n' })
  await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '保存源码').click()")
  current = await waitForFile((text) => text.includes('Edited from packaged source mode.') && text.includes('[^w-go]'), 'saving an explicit source edit')

  await stopApp()
  startApp()
  await connect()
  await waitUi("document.readyState === 'complete' && !!document.querySelector('.reader-scroll')", 'the reopened Markdown document')
  await waitUi("document.querySelectorAll('.vocab-anchor').length === 1", 'rebuilding vocabulary from the saved Markdown document')
  assert.equal(await readFile(filePath, 'utf8'), current, 'Reopening must preserve the saved source and vocabulary text.')
  passed = true
  process.stdout.write(`Packaged Electron smoke passed: ${binary}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${stderr}\n`)
  process.exitCode = 1
} finally {
  await stopApp()
  if (passed) await rm(root, { recursive: true, force: true })
  else process.stderr.write(`Smoke artifacts retained at ${root}\n`)
}
