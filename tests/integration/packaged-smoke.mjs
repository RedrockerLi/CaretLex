import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'undici'

const binary = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Usage: node tests/integration/packaged-smoke.mjs <linux-unpacked-binary-or-appimage> [source-app-directory]')

const root = await mkdtemp(join(tmpdir(), 'caretlex-packaged-smoke-'))
const filePath = join(root, 'reader.md')
const original = '# Reading\n\nShe went home. She went again.\n\nThe bank is beside the river bank.\n\nThe bank is beside the river bank.\n\nHe walked away. He returned home.\n'
await writeFile(filePath, original, 'utf8')
// The private D-Bus session and portal preference keep native dialogs on Xvfb.
const settingsDirectory = join(root, 'config', 'caretlex')
await mkdir(settingsDirectory, { recursive: true })
await writeFile(join(settingsDirectory, 'settings.json'), '{invalid settings', 'utf8')
const portalDirectory = join(root, 'config', 'xdg-desktop-portal')
await mkdir(portalDirectory, { recursive: true })
await writeFile(join(portalDirectory, 'portals.conf'), '[preferred]\ndefault=none\norg.freedesktop.impl.portal.FileChooser=gtk\n', 'utf8')

const portServer = createServer()
await new Promise((resolveListen, rejectListen) => {
  portServer.once('error', rejectListen)
  portServer.listen(0, '127.0.0.1', resolveListen)
})
const port = portServer.address().port
await new Promise((resolveClose, rejectClose) => portServer.close((error) => error ? rejectClose(error) : resolveClose()))

const isAppImage = binary.endsWith('.AppImage')
const appDirectory = process.argv[3] ? resolve(process.argv[3]) : undefined
const appArgs = [
  ...(appDirectory ? [appDirectory] : []),
  ...(isAppImage ? ['--appimage-extract-and-run'] : []),
  '--no-sandbox',
  '--disable-gpu',
  '--ozone-platform=x11',
  `--remote-debugging-port=${port}`,
  filePath,
]
const environment = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  GDK_BACKEND: 'x11',
  GTK_USE_PORTAL: '0',
  XDG_CURRENT_DESKTOP: 'GNOME',
  QT_QPA_PLATFORM: 'xcb',
  WAYLAND_DISPLAY: '',
}

let apiMode = 'success'
const requests = []
const delayed = []
const api = createHttpServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  requests.push({ path: request.url, authorization: request.headers.authorization, headers: request.headers, body })
  const protocol = request.url.endsWith('/responses') ? 'openai-responses' : request.url.endsWith('/messages') ? 'anthropic-messages' : request.url.includes(':generateContent') ? 'gemini' : 'openai-chat'
  const prompt = protocol === 'openai-responses' ? body.input : protocol === 'anthropic-messages' ? body.messages[0].content : protocol === 'gemini' ? body.contents[0].parts[0].text : body.messages[1].content
  const word = /Word: ([^\n]+)/.exec(prompt)?.[1]
  const lemma = word === 'went' ? 'go' : word === 'walked' ? 'walk' : word === 'returned' ? 'return' : 'bank'
  const meaning = prompt.includes('river [bank]') ? '（名词）河岸' : lemma === 'bank' ? '（名词）银行' : '（动词）去'
  const value = { lemma, meaning_in_context: meaning, english_definition: meaning.includes('河岸') ? 'land beside a river' : 'financial institution', other_meanings: [0, 1, 2].map(index => ({ meaning: `（动词）其他义${index}`, english_definition: `definition ${index}`, example_sentence: `Example ${index}.` })) }
  const content = JSON.stringify(value)
  const envelope = protocol === 'openai-responses' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] }] }
    : protocol === 'anthropic-messages' ? { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: content }] }
    : protocol === 'gemini' ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: content }] } }] }
    : { choices: [{ finish_reason: 'stop', message: { content } }] }
  const reply = () => { if (!response.destroyed) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(envelope)) } }
  if (apiMode === 'delay') delayed.push(reply)
  else if (apiMode === 'failure') { response.writeHead(500); response.end('failed') }
  else reply()
})
await new Promise((done, reject) => { api.once('error', reject); api.listen(0, '127.0.0.1', done) })
const apiUrl = `http://127.0.0.1:${api.address().port}/custom/v1`

let child
let socket
let nextId = 1
let passed = false
const pending = new Map()
let stderr = ''

function startApp() {
  child = spawn('dbus-run-session', ['--', binary, ...appArgs], { env: environment, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
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
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
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

async function selectVisibleWord(occurrence, word = 'went') {
  const result = await evaluate(`(() => {
    const root = [...document.querySelectorAll('.reader-scroll')].find(element => element.getClientRects().length);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let found = 0;
    let node;
    while ((node = walker.nextNode())) {
      let start = 0;
      while ((start = node.nodeValue.indexOf(${JSON.stringify(word)}, start)) >= 0) {
        if (found++ === ${occurrence}) {
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + ${word.length});
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return selection.toString();
        }
        start += ${word.length};
      }
    }
    return null;
  })()`)
  assert.equal(result, word, `Selection ${occurrence} could not be made from the rendered DOM.`)
  await waitUi("!!document.querySelector('.selection-toolbar')", 'the selection toolbar')
}

async function setField(selector, value, event = 'input') {
  await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value').set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`)
}
async function clickText(selector, label) { await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(element => element.textContent.trim() === ${JSON.stringify(label)}).click()`) }
async function openComposer(occurrence, word = 'went') {
  await selectVisibleWord(occurrence, word)
  await evaluate("document.querySelector('.selection-toolbar button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))")
  await waitUi("!!document.querySelector('.entry-composer .article-sentence')", 'the article marker in the entry composer')
}
async function editJson(selector, edit) {
  const text = await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`)
  const value = JSON.parse(text); edit(value); await setField(selector, JSON.stringify(value, null, 2))
}
async function submitComposer() {
  await waitUi("document.querySelector('.composer-actions .button-primary')?.disabled === false", 'a valid final JSON entry')
  await evaluate("document.querySelector('.composer-actions .button-primary').click()")
}
async function addManual(occurrence, meaning, word = 'went', lemma = 'go') {
  await openComposer(occurrence, word)
  if (!(await evaluate("document.querySelector('#lemma-input').disabled"))) await setField('#lemma-input', lemma)
  const sentence = await evaluate("document.querySelector('.article-sentence').textContent")
  if (meaning) await editJson('#entry-json', value => {
    value.lemma = lemma
    const context = value.contexts.find(item => item.original_sentence === sentence)
    context.meaning_in_context = meaning
  })
  await submitComposer()
}
async function waitCount(count) {
  const end = Date.now() + 10000
  while (Date.now() < end) { if (requests.length >= count) return; await delay(50) }
  throw new Error('No real HTTP request was received')
}
function entryFrom(text, lemma) { return JSON.parse(new RegExp(`\\[\\^w-${lemma}\\]: (.+)`).exec(text)[1]) }
async function closeComposer() { await evaluate("document.querySelector('.entry-composer .icon-button').click()") }
async function hover(occurrence = 0, word = 'went') {
  await evaluate(`([...document.querySelectorAll('.vocab-anchor')].filter(element => element.textContent === ${JSON.stringify(word)}))[${occurrence}].dispatchEvent(new MouseEvent('mouseenter'))`)
  await waitUi("!!document.querySelector('.vocab-card .translation')", 'the current context hover card')
}
async function screenshot(path) {
  await delay(100) // Allow the real window to paint the last DOM/form update.
  await new Promise((done, reject) => {
    const capture = spawn('import', ['-window', 'root', path], { stdio: 'inherit' })
    capture.once('error', reject); capture.once('exit', code => code === 0 ? done() : reject(new Error('Native screen capture failed')))
  })
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
  startApp(); await connect()
  await waitUi("document.readyState === 'complete' && !!document.querySelector('.reader-scroll')", 'rendered Markdown')
  const brokenSettings = await evaluate('window.caretlex.loadSettings()')
  assert.equal(brokenSettings.value, undefined); assert.ok(brokenSettings.error)
  await clickText('.toolbar-button', '设置')
  await waitUi("document.querySelector('.settings-page')?.innerText.includes('当前配置无法用于表单')", 'invalid settings recovery UI')
  assert.equal(await readFile(brokenSettings.path, 'utf8'), '{invalid settings')
  assert.equal(await evaluate("document.querySelectorAll('.settings-details, [aria-label=\"保存模板\"], [aria-label=\"设置 JSON\"]').length"), 0)
  await screenshot('/tmp/caretlex-settings-recovery.png')
  await clickText('.settings-page button', '恢复默认设置')
  await waitUi("document.querySelector('.settings-page')?.innerText.includes('已恢复并保存默认设置')", 'a real default settings write receipt')
  const initialSettings = await evaluate('window.caretlex.loadSettings()')
  assert.equal(Object.hasOwn(initialSettings.value, 'version'), false); assert.deepEqual(initialSettings.value.providers, [])
  assert.deepEqual(JSON.parse(await readFile(brokenSettings.path, 'utf8')), initialSettings.value)
  await evaluate("document.querySelector('[aria-label=\"关闭设置\"]').click()")
  assert.equal(requests.length, 0)
  await addManual(1, '手填：再次去')
  let current = await waitForFile(text => text.includes('went[^w-go] again.') && text.includes('手填：再次去'), 'manual JSON persistence')
  assert.equal((current.match(/went\[\^w-go\]/g) ?? []).length, 1)
  await waitUi("!document.querySelector('.entry-composer')", 'a successful write receipt')
  await addManual(0, '手填：回家')
  current = await waitForFile(text => (text.match(/went\[\^w-go\]/g) ?? []).length === 2, 'two references sharing contexts')
  assert.equal(entryFrom(current, 'go').contexts.length, 2)
  await waitUi("!document.querySelector('.entry-composer')", 'the second receipt')
  const baseline = await readFile(filePath)
  await addManual(0, '')
  await waitUi("!document.querySelector('.entry-composer')", 'a no-op receipt')
  assert.deepEqual(await readFile(filePath), baseline)
  await hover(0)
  assert.equal(await evaluate("document.querySelector('.vocab-card .translation').textContent"), '手填：回家')
  await clickText('.vocab-card button', '编辑')
  await editJson('#entry-json-edit', value => { value.reviewed = true; value.contexts.find(item => item.original_sentence.includes('home')).meaning_in_context = '真正写入的手改' })
  await clickText('.vocab-card button', '保存修改')
  current = await waitForFile(text => text.includes('真正写入的手改') && text.includes('"reviewed":true'), 'hover editor write receipt')
  await waitUi("!document.querySelector('#entry-json-edit')", 'leaving edit mode after persistence')
  await evaluate("document.querySelector('.vocab-card .icon-button').click()")

  await clickText('.toolbar-button', '设置')
  await clickText('.settings-page button', '添加 provider')
  await waitUi("!!document.querySelector('.provider-form')", 'an LLM form')
  assert.equal(await evaluate("document.querySelector('.provider-expand').getAttribute('aria-expanded')"), 'true', 'A new provider opens for editing')
  await evaluate("document.querySelector('.provider-expand').click()")
  assert.equal(await evaluate("document.querySelector('.provider-fields').getClientRects().length"), 0, 'Collapsing hides the provider fields')
  assert.ok(await evaluate("[...document.querySelectorAll('.provider-actions .button')].every(button => button.getBoundingClientRect().height >= 40)"), 'Provider actions remain large and visible when collapsed')
  await evaluate("document.querySelector('.provider-expand').click()")
  await setField('[data-field=name]', '__proto__', 'change')
  await setField('[data-field=baseUrl]', apiUrl)
  await setField('[data-field=model]', 'local-test-model')
  await setField('[data-field=key]', 'smoke-test-key')
  const responseExample = await evaluate("document.querySelector('[data-field=responseTemplate]').value")
  await setField('[data-field=responseTemplate]', '{unfinished JSON')
  assert.equal(await evaluate("!!document.querySelector('.settings-dirty-label') && document.querySelector('.settings-actions .button-primary').disabled"), true)
  await setField('[data-field=model]', 'a-temporary-model')
  assert.equal(await evaluate("document.querySelector('[data-field=responseTemplate]').value"), '{unfinished JSON', 'An unrelated field change preserves incomplete JSON input')
  await setField('[data-field=responseTemplate]', responseExample)
  await setField('[data-field=model]', 'local-test-model')

  for (const name of ['constructor', '__v_isReactive', '__proto__']) {
    await setField('[data-field=name]', name, 'change')
    assert.equal(await evaluate("document.querySelector('[data-field=key]').value"), 'smoke-test-key', 'Renaming preserves pending credentials for every legal name')
  }
  await evaluate("document.querySelector('[data-field=enabled]').click()")
  await waitUi("document.querySelector('.settings-page').innerText.includes('已生成 __proto__ 的完整保存预设')", 'the actual-name save preset')
  await clickText('.settings-page button', '添加 provider')
  await setField('.provider-form:last-child [data-field=baseUrl]', apiUrl)
  await setField('.provider-form:last-child [data-field=model]', 'local-test-model')
  await evaluate("document.querySelectorAll('.provider-expand')[1].click()")
  await evaluate("document.querySelectorAll('[data-field=enabled]')[1].click()")
  await waitUi("document.querySelector('.settings-page').innerText.includes('已生成 llm_1 的完整保存预设')", 'switching the whole preset to another same-type instance')
  await clickText('.settings-page button', '保存设置')
  await waitUi("!document.querySelector('.settings-dirty-label')", 'saving the switched provider')
  assert.equal((await evaluate('window.caretlex.loadSettings()')).value.saveTemplate.lemma, 'llm_1.lemma')
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-field=enabled]')].map(element => element.getAttribute('aria-pressed'))"), ['false', 'true'])
  await evaluate("[...document.querySelectorAll('.provider-form')][1].querySelector('.provider-delete').click()")
  await evaluate("document.querySelector('[data-field=enabled]').click()")
  await waitUi("document.querySelector('.settings-page').innerText.includes('已生成 __proto__ 的完整保存预设')", 'restoring the first instance preset')
  await setField('[data-field=name]', 'Renamed-3', 'change')
  await clickText('.settings-page button', '保存设置')
  await waitUi("!document.querySelector('.settings-dirty-label')", 'saving the renamed provider')
  assert.equal((await evaluate('window.caretlex.loadSettings()')).value.saveTemplate.other_meanings[0].meaning, 'Renamed-3.other_meanings[].meaning', 'Form renaming preserves mapping references')
  await setField('[data-field=name]', '__proto__', 'change')
  await clickText('.settings-page button', '保存设置')
  await waitUi("!document.querySelector('.settings-dirty-label')", 'saved settings')
  await evaluate("document.querySelector('.settings-overlay').scrollTop = 0")
  assert.equal(await evaluate("document.querySelectorAll('.settings-details, [aria-label=\"保存模板\"], [aria-label=\"设置 JSON\"]').length"), 0)
  assert.equal(await evaluate("document.querySelector('[data-field=type]').value"), 'LLM')
  assert.equal(await evaluate("document.querySelector('[data-field=apiType]').options.length"), 4)
  assert.equal(await evaluate("document.querySelector('.settings-page').scrollWidth <= document.querySelector('.settings-page').clientWidth"), true)
  assert.ok(await evaluate("document.querySelector('[data-field=prompt]').clientHeight >= 220 && document.querySelector('[data-field=responseTemplate]').clientHeight >= 220"))
  await screenshot('/tmp/caretlex-settings.png')
  await evaluate("document.querySelector('.settings-editors').scrollIntoView({block:'center'})")
  await screenshot('/tmp/caretlex-settings-editors.png')
  await send('Emulation.setDeviceMetricsOverride', { width: 680, height: 850, deviceScaleFactor: 1, mobile: false })
  await evaluate("document.querySelector('.settings-overlay').scrollTop = 0")
  assert.equal(await evaluate("document.querySelector('.settings-page').scrollWidth <= document.querySelector('.settings-page').clientWidth"), true)
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.settings-editors')).gridTemplateColumns.split(' ').length"), 1)
  await delay(100)
  await writeFile('/tmp/caretlex-settings-compact.png', Buffer.from((await send('Page.captureScreenshot')).data, 'base64'))
  await send('Emulation.clearDeviceMetricsOverride')
  const configured = await evaluate('window.caretlex.loadSettings()')
  const configPath = configured.path
  const credentialPath = join(resolve(configPath, '..'), 'credentials.json')
  assert.equal(configured.value.providers[0].name, '__proto__')
  assert.equal(configured.value.providers[0].enabled, true)
  assert.equal(configured.value.saveTemplate.lemma, '__proto__.lemma')
  assert.equal(configured.value.saveTemplate.other_meanings[0].meaning, '__proto__.other_meanings[].meaning')
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600)
  assert.ok(!(await readFile(configPath, 'utf8')).includes('smoke-test-key'))
  await evaluate("document.querySelector('[aria-label=\"关闭设置\"]').click()")

  apiMode = 'delay'
  await openComposer(0, 'bank'); await waitCount(1)
  assert.equal(requests[0].path, '/custom/v1/chat/completions')
  assert.equal(requests[0].authorization, 'Bearer smoke-test-key')
  assert.ok(requests[0].body.messages[1].content.includes('The [bank] is beside the river bank.'))
  await editJson('#entry-json', value => { value.hand = 'protected draft' })
  const handDraft = await evaluate("document.querySelector('#entry-json').value")
  delayed.splice(0).forEach(reply => reply())
  await waitUi("document.querySelector('.entry-composer').innerText.includes('新结果可应用')", 'a pending late result')
  assert.equal(await evaluate("document.querySelector('#entry-json').value"), handDraft)
  await clickText('.entry-composer button', '应用新结果并替换草稿')
  assert.equal(JSON.parse(await evaluate("document.querySelector('#entry-json').value")).other_meanings.length, 3)
  await editJson('#entry-json', value => { value.contexts[0].meaning_in_context = '手改银行'; value.reviewed = true })
  await screenshot('/tmp/caretlex-composer.png')
  await submitComposer()
  current = await waitForFile(text => text.includes('手改银行'), 'a reviewed AI JSON entry')
  await waitUi("!document.querySelector('.entry-composer')", 'the AI save receipt')
  apiMode = 'success'
  await openComposer(1, 'bank')
  await waitCount(2)
  await waitUi("!document.querySelector('.entry-composer').innerText.includes('正在获取自动数据') && JSON.parse(document.querySelector('#entry-json').value).contexts?.length === 2", 'merging the second marked bank')
  await submitComposer()
  current = await waitForFile(text => (text.match(/bank\[\^w-bank\]/g) ?? []).length === 2, 'second marker persistence')
  assert.equal(entryFrom(current, 'bank').contexts.length, 2)
  assert.equal(entryFrom(current, 'bank').contexts[0].meaning_in_context, '手改银行')
  assert.equal(entryFrom(current, 'bank').reviewed, true)
  await waitUi("!document.querySelector('.entry-composer')", 'the merged receipt')
  await openComposer(2, 'bank')
  await waitCount(3)
  await waitUi("!document.querySelector('.entry-composer').innerText.includes('正在获取自动数据')", 'duplicate-key acquisition')
  await submitComposer()
  current = await waitForFile(text => (text.match(/bank\[\^w-bank\]/g) ?? []).length === 3, 'same context in another paragraph')
  assert.equal(entryFrom(current, 'bank').contexts.length, 2)
  await waitUi("!document.querySelector('.entry-composer')", 'the duplicate-key receipt')
  const hoverCount = requests.length
  await hover(1, 'bank')
  assert.equal(await evaluate("document.querySelector('.vocab-card .translation').textContent"), '（名词）河岸')
  assert.equal(requests.length, hoverCount)
  await screenshot('/tmp/caretlex-card.png')
  await clickText('.vocab-card button', '编辑')
  await editJson('#entry-json-edit', value => { value.lemma = 'other' })
  await clickText('.vocab-card button', '保存修改')
  await waitUi("document.querySelector('.vocab-card').innerText.includes('身份已锁定')", 'lemma locking')
  assert.ok(await evaluate("!!document.querySelector('#entry-json-edit')"))
  await editJson('#entry-json-edit', value => { value.lemma = 'bank'; value.externalConflictDraft = true })
  const conflictedDraft = await evaluate("document.querySelector('#entry-json-edit').value")
  current = current.replace('# Reading', '# External change')
  await writeFile(filePath, current)
  await delay(400)
  await clickText('.vocab-card button', '保存修改')
  await waitUi("document.querySelector('.vocab-card .error-text')?.textContent.includes('外部修改')", 'a rejected stale edit')
  assert.equal(await evaluate("document.querySelector('#entry-json-edit').value"), conflictedDraft)
  assert.equal(await readFile(filePath, 'utf8'), current)
  await evaluate("document.querySelector('.vocab-card .icon-button').click()")

  apiMode = 'failure'
  await openComposer(0, 'walked')
  await waitUi("document.querySelector('.entry-composer').innerText.includes('HTTP 500')", 'provider failure')
  await setField('#lemma-input', 'walk')
  await editJson('#entry-json', value => { value.lemma = 'walk'; value.contexts[0].meaning_in_context = '手动兜底'; value.manual = true })
  const fallback = await evaluate("document.querySelector('#entry-json').value")
  apiMode = 'success'
  await clickText('.entry-composer button', '手动重新获取')
  await waitUi("document.querySelector('.entry-composer').innerText.includes('新结果可应用')", 'a protected manual retry')
  assert.equal(await evaluate("document.querySelector('#entry-json').value"), fallback)
  await submitComposer()
  current = await waitForFile(text => text.includes('手动兜底'), 'manual fallback after a failed provider')
  await waitUi("!document.querySelector('.entry-composer')", 'manual fallback receipt')

  apiMode = 'delay'
  const previousCount = requests.length
  await openComposer(0, 'returned'); await waitCount(previousCount + 1)
  await editJson('#entry-json', value => { value.retained = 'across settings and tabs' })
  const retained = await evaluate("document.querySelector('#entry-json').value")
  await clickText('.toolbar-button', '新建')
  await clickText('.document-tab .tab-title', 'reader.md')
  assert.equal(await evaluate("document.querySelector('#entry-json').value"), retained)
  await clickText('.toolbar-button', '设置')
  await setField('[data-field=model]', 'local-test-model-2')
  await clickText('.settings-page button', '保存设置')
  await waitUi("!document.querySelector('.settings-dirty-label')", 'a changed settings revision')
  await evaluate("document.querySelector('[aria-label=\"关闭设置\"]').click()")
  assert.equal(await evaluate("document.querySelector('#entry-json').value"), retained)
  await waitUi("document.querySelector('.entry-composer').innerText.includes('设置已变化')", 'settings invalidation without losing text')
  delayed.splice(0).forEach(reply => reply())
  apiMode = 'success'
  await clickText('.entry-composer button', '手动重新获取')
  await waitUi("document.querySelector('.entry-composer').innerText.includes('新结果可应用')", 'acquisition with new saved settings')
  assert.equal(await evaluate("document.querySelector('#entry-json').value"), retained)
  await closeComposer()

  await hover(0, 'walked')
  await clickText('.vocab-card button', '删除')
  await clickText('.vocab-card button', '确认删除')
  current = await waitForFile(text => !text.includes('[^w-walk]'), 'deleting a managed definition and all its references')
  await waitUi("!document.querySelector('.vocab-card')", 'a delete receipt')
  await addManual(0, '再次手填', 'walked', 'walk')
  current = await waitForFile(text => text.includes('再次手填'), 'saving after a real delete')
  await waitUi("!document.querySelector('.entry-composer')", 'resaving after deletion')
  await clickText('.toolbar-button', '源码')
  await waitUi("document.querySelector('.cm-content')?.isContentEditable === true", 'CodeMirror source mode')
  await evaluate(`(() => {
    const editor = document.querySelector('.cm-content'); editor.focus();
    const range = document.createRange(); range.selectNodeContents(editor); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  })()`)
  await send('Input.insertText', { text: 'Source smoke verification.\n\n' })
  await clickText('button', '保存源码')
  current = await waitForFile(text => text.startsWith('Source smoke verification.') && text.includes('[^w-bank]'), 'source persistence with the managed block retained')
  await clickText('.toolbar-button', '阅读')

  // Change each API in the form, save it, then acquire data through the actual IPC/service path.
  for (const apiType of ['openai-responses', 'anthropic-messages', 'gemini']) {
    await clickText('.toolbar-button', '设置')
    await setField('[data-field=apiType]', apiType, 'change')
    if (apiType !== 'anthropic-messages') await evaluate("document.querySelector('[data-field=jsonMode]').checked || document.querySelector('[data-field=jsonMode]').click()")
    else assert.equal(await evaluate("document.querySelector('[data-field=jsonMode]').disabled && !document.querySelector('[data-field=jsonMode]').checked"), true)
    await clickText('.settings-page button', '保存设置')
    await waitUi("!document.querySelector('.settings-dirty-label')", 'saved API selection')
    assert.equal((await evaluate('window.caretlex.loadSettings()')).value.providers[0].config.apiType, apiType)
    await evaluate("document.querySelector('[aria-label=\"关闭设置\"]').click()")
    const count = requests.length
    await openComposer(0, 'returned'); await waitCount(count + 1)
    await waitUi("!document.querySelector('.entry-composer').innerText.includes('正在获取自动数据') && JSON.parse(document.querySelector('#entry-json').value).lemma === 'return'", `automatic ${apiType} mapping`)
    const request = requests.at(-1)
    if (apiType === 'openai-responses') { assert.equal(request.path, '/custom/v1/responses'); assert.deepEqual(request.body.text.format, { type: 'json_object' }) }
    else if (apiType === 'anthropic-messages') { assert.equal(request.path, '/custom/v1/messages'); assert.equal(request.headers['x-api-key'], 'smoke-test-key'); assert.ok(request.body.max_tokens > 0) }
    else { assert.equal(request.path, '/custom/v1/models/local-test-model-2:generateContent'); assert.equal(request.headers['x-goog-api-key'], 'smoke-test-key'); assert.equal(request.body.generationConfig.responseMimeType, 'application/json') }
    await closeComposer()
  }

  // The real GTK save chooser changes the settings path; credentials stay local.
  const syncDirectory = join(root, 'sync'); await mkdir(syncDirectory)
  const targetPath = join(syncDirectory, 'settings.json')
  await clickText('.toolbar-button', '设置')
  await clickText('.settings-page button', '更改位置')
  await delay(800)
  await screenshot('/tmp/caretlex-dialog.png')
  await new Promise((done, reject) => { const keyboard = spawn('python3', ['tests/integration/dialog-keyboard.py', targetPath], { stdio: 'inherit' }); keyboard.once('exit', code => code === 0 ? done() : reject(new Error('Native chooser input failed'))) })
  await waitUi(`document.querySelector('.path-value')?.textContent === ${JSON.stringify(targetPath)}`, 'a real settings path dialog', 15000)
  const migration = await evaluate('window.caretlex.loadSettings()')
  assert.equal(migration.path, targetPath)
  assert.ok(!(await readFile(targetPath, 'utf8')).includes('smoke-test-key'))
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600)
  await evaluate("document.querySelector('[aria-label=\"关闭设置\"]').click()")

  await stopApp(); startApp(); await connect()
  await waitUi("document.readyState === 'complete' && document.querySelectorAll('.vocab-anchor').length === 6", 'reopening persisted contexts and references')
  assert.equal(await readFile(filePath, 'utf8'), current)
  const reopened = await evaluate('window.caretlex.loadSettings()')
  assert.equal(reopened.path, targetPath)
  assert.equal(reopened.value.providers[0].type, 'LLM'); assert.equal(reopened.value.providers[0].config.apiType, 'gemini'); assert.equal(Object.hasOwn(reopened.value, 'version'), false)
  assert.equal((await evaluate(`window.caretlex.credentialStatus(${JSON.stringify(configured.value.providers[0].config.apiKeyRef)})`)).exists, true)
  assert.equal(entryFrom(current, 'go').contexts.length, 2); assert.equal(entryFrom(current, 'bank').contexts.length, 2)
  passed = true
  process.stdout.write(`${appDirectory ? 'Electron source-build' : 'Packaged Electron'} smoke passed (local HTTP protocol only): ${binary}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${stderr}\n`)
  process.exitCode = 1
} finally {
  await stopApp()
  api.closeAllConnections(); await new Promise(done => api.close(done))
  if (passed) await rm(root, { recursive: true, force: true })
  else process.stderr.write(`Smoke artifacts retained at ${root}\n`)
}
