/// <reference lib="dom" />
// Run explicitly in an isolated VS Code Extension Development Host, never Chrome.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import * as vscode from 'vscode'
import { Inspector, until } from './question-vscode-smoke.js'
import { SkillController } from '../host/skill-controller.js'
import { SidebarProvider, type SidebarMessage, type SidebarSettings, type SidebarOutgoingMessage } from '../sidebar/sidebar-provider.js'
import { DEFAULT_DECISION_SETTINGS, type SkillCatalog, type SkillTurnSelection } from '../shared/skills.js'

export async function run(): Promise<void> {
  const requests: Array<{ url?: string; authorization?: string; body: any }> = []
  const selections: SkillTurnSelection[] = []
  const messages: SidebarMessage[] = []
  const postedMessages: SidebarOutgoingMessage[] = []
  let failing = false
  let alphaProbability = 0.9
  let sessionId = 'skills-smoke'
  let independentKey = ''
  let panel: vscode.WebviewPanel | undefined
  let ui: Inspector | undefined
  let diagnosticContext: { id: number; sessionId: string } | undefined
  let routing: SkillController | undefined
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    requests.push({ url: request.url, authorization: request.headers.authorization, body })
    if (failing) { response.writeHead(503); response.end(); return }
    const names = Array.isArray(body.questions) ? body.questions.map((entry: any) => entry.name) : Object.keys(body.questions)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ answers: request.url?.endsWith('/decisions')
      ? names.map((name: string) => ({ name, type: 'predicate', probability: name === 'alpha' ? alphaProbability : 0.1 }))
      : Object.fromEntries(names.map((name: string) => [name, { type: 'noul', noul: name === 'alpha' ? alphaProbability : 0.1 }])) }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/proxy/v1`
  let settings: SidebarSettings = { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 128000,
    baseUrl, dshHome: '', apiKeyConfigured: true, skillPickerEnabled: false, sandboxMode: 'read-only', mcpServers: [],
    decisions: { ...DEFAULT_DECISION_SETTINGS, apiKeyConfigured: false } }
  const catalog: SkillCatalog = { complete: true, revision: 'native-smoke', skills: ['alpha', 'beta', 'gamma'].map((name) => ({
    name, description: `Instructions for ${name}, with a description that wraps in a narrow sidebar.`, modelInvocable: true, userInvocable: true,
  })) }
  const state = () => ({ activeSessionId: sessionId, runtimeState: 'ready' as const })
  let sidebar: SidebarProvider
  const post = (message: SidebarOutgoingMessage) => { postedMessages.push(message); sidebar.post(message) }
  try {
    const extension = vscode.extensions.getExtension('local.helix-vscode')!
    routing = new SkillController({ catalog: async () => catalog,
      connection: async () => ({ ...settings.decisions!, baseUrl: settings.decisions!.useMainConnection ? settings.baseUrl : settings.decisions!.baseUrl,
        apiKey: settings.decisions!.useMainConnection ? 'main-smoke-key' : independentKey, threshold: 0.75 }),
      metadata: () => 'Native smoke workspace', currentSession: () => sessionId,
      publish: (suggestions) => post({ type: 'skillSuggestions', suggestions }),
      publishCatalog: (id, value) => post({ type: 'skillCatalog', sessionId: id, catalog: value }),
    })
    sidebar = new SidebarProvider(extension.extensionUri, state, async (message) => {
      messages.push(message)
      if (message.type === 'ready') { post({ type: 'state', state: state(), resetTranscript: true }); post({ type: 'settings', settings }) }
      if (message.type === 'openSettings') post({ type: 'settings', settings })
      if (message.type === 'loadSkills') await routing!.loadCatalog(message.sessionId)
      if (message.type === 'analyzeSkills') routing!.update(message.draft)
      if (message.type === 'saveSettings') {
        if (message.decisionsApiKey) independentKey = message.decisionsApiKey
        if (message.clearDecisionsApiKey) independentKey = ''
        settings = { ...settings, baseUrl: message.baseUrl,
          ...(message.decisions ? { decisions: { ...message.decisions, apiKeyConfigured: !!independentKey } } : {}) }
        routing!.invalidate()
        post({ type: 'skillsInvalidated' })
        post({ type: 'settingsSaved', settings, restarting: false })
      }
      if (message.type === 'submit') {
        if (settings.skillPickerEnabled) selections.push(await routing!.freeze(message.skillDraft!, message.skillOverrides!))
        routing!.cancel()
        post({ type: 'submitFailed', sessionId, message: 'Intentional smoke-test failure' })
      }
      if (message.type === 'newSession') {
        routing!.invalidate(); sessionId = 'skills-smoke-new'
        post({ type: 'state', state: state(), resetTranscript: true })
      }
    })
    panel = vscode.window.createWebviewPanel('helix-skills-smoke', 'Helix Skills Test', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true })
    sidebar.resolveWebviewView(panel as unknown as vscode.WebviewView)
    const debugPort = process.env.HELIX_SMOKE_DEBUG_PORT ?? '9340'
    const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json() as any
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Inspector connection failed')), { once: true }) })
    ui = new Inspector(socket)
    const attached = new Set<string>()
    let context: { id: number; sessionId: string } | undefined
    let pageSession: string | undefined
    await until(async () => {
      for (const target of (await ui!.request('Target.getTargets')).targetInfos) {
        if (!['page', 'iframe', 'webview'].includes(target.type) || attached.has(target.targetId)) continue
        const { sessionId: targetSession } = await ui!.request('Target.attachToTarget', { targetId: target.targetId, flatten: true })
        attached.add(target.targetId)
        if (target.type === 'page') pageSession ??= targetSession
        await ui!.request('Runtime.enable', {}, targetSession)
      }
      for (const candidate of ui!.contexts) {
        try { if (await ui!.evaluate(candidate, '!!document.querySelector("textarea[aria-label=Prompt]")')) { context = candidate; return true } } catch { /* Other worlds can disappear. */ }
      }
      return false
    })
    diagnosticContext = context
    const evaluate = (expression: string) => ui!.evaluate(context!, expression)
    const input = async (selector: string, value: string) => evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    const openSettings = async () => {
      await evaluate(`document.querySelector('#settings-menu-trigger').click()`)
      await evaluate(`document.querySelector('#settings-menu-list button').click()`)
      await until(async () => !!await evaluate(`document.querySelector('.settings-view')`))
    }
    const back = async () => { await evaluate(`document.querySelector('button[aria-label="Back to chat"]').click()`); await until(async () => !!await evaluate(`document.querySelector('textarea[aria-label=Prompt]')`)) }
    const save = async () => {
      await evaluate(`document.querySelector('.settings-view form').requestSubmit()`)
      await until(() => messages.some((message) => message.type === 'saveSettings'))
      await until(async () => !await evaluate(`document.querySelector('.settings-view form button[type=submit]').disabled`))
      await back()
    }
    assert.equal(await evaluate(`!!document.querySelector('section[aria-label="Skills for the next message"]')`), false)
    await input('textarea[aria-label=Prompt]', 'The picker is paused')
    await openSettings()
    assert.equal(await evaluate(`!!document.querySelector('#decisions-enabled')`), false)
    assert.equal(messages.some((message) => message.type === 'loadSkills' || message.type === 'analyzeSkills'), false)
    await back()
    settings = { ...settings, skillPickerEnabled: true }
    post({ type: 'settings', settings })
    await until(async () => await evaluate(`document.querySelectorAll('section[aria-label="Skills for the next message"] label').length`) === 3)
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] details').open`), false)
    await ui.request('Page.bringToFront', {}, pageSession)
    await ui.request('Emulation.setFocusEmulationEnabled', { enabled: true }, context!.sessionId)
    await evaluate(`window.focus();document.querySelector('section[aria-label="Skills for the next message"] summary').focus()`)
    await ui.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 }, context!.sessionId)
    await ui.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, context!.sessionId)
    await until(async () => !!await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] details').open`))
    await evaluate(`document.querySelectorAll('section[aria-label="Skills for the next message"] label input')[1].click()`)
    await input('textarea[aria-label=Prompt]', 'Apply the alpha skill')
    await until(async () => await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary .whitespace-nowrap span').textContent`) === '1')
    assert.equal(requests.length, 0, 'Routing is disabled by default')
    await openSettings()
    await evaluate(`document.querySelector('#decisions-enabled').click()`)
    await input('#decisions-model', 'smoke-jev')
    await save()
    await until(() => requests.length > 0)
    await until(async () => await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary [aria-live="polite"]').textContent`) === 'Ready')
    assert.equal(requests[0].url, '/proxy/v1/systemone')
    assert.equal(requests[0].authorization, 'Bearer main-smoke-key')
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary .whitespace-nowrap span').textContent`), '2')
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('section[aria-label="Skills for the next message"] p')).some(el => el.textContent.includes('75.0%'))`))
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('section[aria-label="Skills for the next message"] label span')).map(el=>el.textContent).filter(text=>text.startsWith('Match '))`), ['Match 90.0%', 'Match 10.0%', 'Match 10.0%'])
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] details').open`), false, 'Recreated drawer starts collapsed')
    assert.ok(await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary').textContent.includes('alpha')`), 'Collapsed badges are visible')
    await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary').click()`)
    await evaluate(`document.querySelectorAll('section[aria-label="Skills for the next message"] label input')[0].click()`)
    await input('textarea[aria-label=Prompt]', 'Apply alpha with edited instructions')
    await until(async () => await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary [aria-live="polite"]').textContent`) === 'Ready')
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] details').open`), true, 'Updates preserve expanded state')
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary .whitespace-nowrap span').textContent`), '1', 'Explicit exclusion survives rerouting')
    await input('input[aria-label="Search skills"]', 'gamma')
    await until(async () => await evaluate(`document.querySelectorAll('section[aria-label="Skills for the next message"] label').length`) === 1)
    await input('input[aria-label="Search skills"]', '')
    await evaluate(`document.querySelector('.shell').style.width='300px'`)
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Skills for the next message"]').scrollWidth <= document.querySelector('section[aria-label="Skills for the next message"]').clientWidth`), true)
    const screenshot = await ui.request('Page.captureScreenshot', { format: 'png' }, pageSession).catch(() => undefined)
    if (screenshot?.data) await writeFile('/tmp/helix-skills-drawer.png', Buffer.from(screenshot.data, 'base64'))
    await evaluate(`document.querySelector('textarea[aria-label=Prompt]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`)
    await until(() => selections.length === 1)
    await until(async () => !await evaluate(`document.querySelector('textarea[aria-label=Prompt]').disabled`))
    assert.deepEqual(selections[0].include, ['beta'])
    assert.deepEqual(selections[0].exclude, ['alpha'])
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label=Prompt]').value`), 'Apply alpha with edited instructions')
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary .whitespace-nowrap span').textContent`), '1', 'Failed submission retains manual choices')
    await openSettings()
    await evaluate(`document.querySelector('#decisions-main').click()`)
    await input('#decisions-url', baseUrl.replace(/\/v1$/, '/separate'))
    await input('#decisions-key', 'separate-smoke-key')
    await evaluate(`document.querySelector('#decisions-format-trigger').click()`)
    await evaluate(`document.querySelector('#decisions-format-list [data-value=openai]').click()`)
    await until(async () => await evaluate(`Array.from(document.querySelectorAll('.settings-view small')).some(el => el.textContent?.includes('/decisions'))`))
    await input('#decisions-model', 'smoke-openai')
    await save()
    await until(() => !!requests.find((request) => request.url?.endsWith('/decisions')))
    const openai = requests.find((request) => request.url?.endsWith('/decisions'))!
    assert.equal(openai.url, '/proxy/separate/v1/decisions')
    assert.equal(openai.authorization, 'Bearer separate-smoke-key')
    assert.ok(Array.isArray(openai.body.questions))
    await openSettings()
    await evaluate(`document.querySelector('#decisions-main').click()`)
    await back()
    await openSettings()
    assert.equal(await evaluate(`document.querySelector('#decisions-main').checked`), false, 'Discard restores saved connection mode')
    await back()
    failing = true
    await input('textarea[aria-label=Prompt]', 'Endpoint failure preserves choices')
    await until(async () => await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary [aria-live="polite"]').textContent`) === 'Suggestions unavailable')
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary .whitespace-nowrap span').textContent`), '1')
    await evaluate(`document.querySelector('textarea[aria-label=Prompt]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`)
    await until(() => selections.length === 2)
    assert.deepEqual(selections[1].include, ['beta'], 'Failed endpoint still submits the manual inclusion')
    assert.deepEqual(selections[1].exclude, ['alpha'])
    await until(async () => !await evaluate(`document.querySelector('textarea[aria-label=Prompt]').disabled`))
    await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary').click()`)
    await evaluate(`Array.from(document.querySelectorAll('section[aria-label="Skills for the next message"] button')).find(button => button.textContent.includes('Reset choices')).click()`)
    await until(async () => await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary .whitespace-nowrap span').textContent`) === '0')
    failing = false
    alphaProbability = 0.74
    await input('textarea[aria-label=Prompt]', 'A completed decision below the cutoff')
    await until(async () => await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary [aria-live="polite"]').textContent`) === 'No suggestions')
    assert.equal(await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary .whitespace-nowrap span').textContent`), '0')
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('section[aria-label="Skills for the next message"] label span')).some(el => el.textContent === 'Match 74.0%')`))
    await evaluate(`document.querySelectorAll('section[aria-label="Skills for the next message"] label input')[2].click()`)
    await until(async () => await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary .whitespace-nowrap span').textContent`) === '1')
    await evaluate(`document.querySelector('button[aria-label="New session"]').click()`)
    await until(async () => await evaluate(`document.querySelector('section[aria-label="Skills for the next message"] summary .whitespace-nowrap span').textContent`) === '0')
    routing.invalidate()
    settings = { ...settings, skillPickerEnabled: false }
    post({ type: 'settings', settings })
    await until(async () => !await evaluate(`document.querySelector('section[aria-label="Skills for the next message"]')`))
    const routingMessages = messages.filter((message) => message.type === 'loadSkills' || message.type === 'analyzeSkills').length
    const requestCount = requests.length
    await input('textarea[aria-label=Prompt]', 'Normal chat while the picker is paused')
    await openSettings()
    assert.equal(await evaluate(`!!document.querySelector('#decisions-enabled')`), false)
    await save()
    const restored = { ...settings.decisions! }
    await evaluate(`document.querySelector('textarea[aria-label=Prompt]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`)
    await until(() => messages.filter((message) => message.type === 'submit').length === 3)
    await until(async () => !await evaluate(`document.querySelector('textarea[aria-label=Prompt]').disabled`))
    const submitted = messages.filter((message) => message.type === 'submit').at(-1)!
    assert.equal(submitted.skillDraft, undefined)
    assert.equal(submitted.skillOverrides, undefined)
    assert.equal(messages.filter((message) => message.type === 'loadSkills' || message.type === 'analyzeSkills').length, routingMessages)
    assert.equal(requests.length, requestCount)
    settings = { ...settings, skillPickerEnabled: true }
    post({ type: 'settings', settings })
    await until(async () => !!await evaluate(`document.querySelector('section[aria-label="Skills for the next message"]')`))
    await until(() => requests.length > requestCount)
    await openSettings()
    assert.equal(await evaluate(`document.querySelector('#decisions-model').value`), restored.model)
    assert.equal(await evaluate(`document.querySelector('#decisions-main').checked`), restored.useMainConnection)
    assert.equal(independentKey, 'separate-smoke-key')
    await back()
    await writeFile('/tmp/helix-skills-smoke-result.json', JSON.stringify({ passed: true, vscode: vscode.version,
      checks: ['feature flag defaults off', 'live flag toggle', 'hidden decisions controls', 'no routing or submitted overrides while paused', 'saved settings restored', 'disabled routing/manual selection', 'keyboard disclosure', 'TypeSafe main connection', 'OpenAI separate connection', 'independent credentials',
        'collapsed badges', 'probability and cutoff feedback', 'below-cutoff No suggestions feedback', 'expansion preserved', 'search', '300px layout', 'manual include/exclude', 'failed submit retention', 'settings discard', 'HTTP failure fallback on Send', 'reset choices', 'new-chat reset'] }, null, 2))
  } catch (error) {
    let diagnostics: unknown
    try {
      if (ui !== undefined && diagnosticContext !== undefined) {
      diagnostics = await ui.evaluate(diagnosticContext, `JSON.stringify({ settings: !!document.querySelector('.settings-view'), drawer: document.querySelector('[aria-label="Skills for the next message"]')?.outerHTML.slice(0, 1000), formValid: document.querySelector('.settings-view form')?.checkValidity(), invalid: Array.from(document.querySelectorAll('.settings-view form :invalid')).map(el => [el.id, el.value]), decisionsModel: document.querySelector('#decisions-model')?.value, submitDisabled: document.querySelector('.settings-view form button[type=submit]')?.disabled, triggerExpanded: document.querySelector('#settings-menu-trigger')?.getAttribute('aria-expanded') })`)
      }
    } catch { /* Preserve the original smoke failure. */ }
    await writeFile('/tmp/helix-skills-smoke-result.json', JSON.stringify({ passed: false, error: error instanceof Error ? error.stack : String(error), requests: requests.length, messageTypes: messages.map((message) => message.type), postedTypes: postedMessages.map((message) => message.type), diagnostics }, null, 2))
    throw error
  } finally {
    routing?.invalidate(); ui?.close(); panel?.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
