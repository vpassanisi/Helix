/// <reference lib="dom" />
// Explicit VS Code Extension Development Host test; never run by the Node suite.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { HarnessRuntime } from '../runtime/harness-runtime.js'
import { SessionController } from '../host/session-controller.js'
import { SidebarProvider, type SidebarState, type SidebarOutgoingMessage } from '../sidebar/sidebar-provider.js'
import type { WorkspaceChangeTracker } from '../runtime/change-tracker.js'

export class Inspector {
  private nextId = 1
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  readonly contexts: Array<{ id: number; sessionId: string }> = []
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.method === 'Runtime.executionContextCreated') this.contexts.push({ id: message.params.context.id, sessionId: message.sessionId })
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }
  request(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  async evaluate(context: { id: number; sessionId: string }, expression: string): Promise<any> {
    const value = await this.request('Runtime.evaluate', { expression, contextId: context.id, returnByValue: true, awaitPromise: true }, context.sessionId)
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails))
    return value.result?.value
  }
  close(): void { this.socket.close() }
}

export async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Question smoke test timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export async function run(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-question-smoke-'))
  const bodies: any[] = []
  const errors: string[] = []
  let ui: Inspector | undefined
  let panel: vscode.WebviewPanel | undefined
  let controller: SessionController | undefined
  let stage = 'choice'
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    bodies.push(body)
    const messages = body.messages ?? []
    const last = messages.filter((message: any) => message.role === 'tool' && message.tool_call_id?.startsWith(`question-${stage}-`)).at(-1)
    const hasAnswer = last?.role === 'tool' && last.content?.includes('"answers"')
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const delta = hasAnswer || last?.role === 'tool'
      ? { role: 'assistant', content: 'Answer received. Continuing the same turn.' }
      : { role: 'assistant', tool_calls: [{ index: 0, id: `question-${stage}-${bodies.length}`, type: 'function', function: {
          name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'scope', question: `Question stage: ${stage}`, options: [
            { label: 'Current project (Recommended)', description: 'Only update this project.' },
            { label: 'All projects', description: 'Apply the change everywhere.' },
            { label: 'Future projects', description: 'Apply to new projects.' },
          ] }] }),
        } }] }
    const chunk = (delta: unknown, reason: string | null) => response.write(`data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`)
    chunk(delta, null)
    chunk({}, hasAnswer ? 'stop' : 'tool_calls')
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const runtime = new HarnessRuntime({ onControlEvent: (event) => controller?.handleControlEvent(event),
    onLifecycleError: (error) => errors.push(String(error)) })
  let sidebar: SidebarProvider
  const state = (): SidebarState => ({ activeSessionId: controller!.currentSessionId, runtimeState: runtime.currentState, pendingQuestions: controller!.questions })
  const post = (message: SidebarOutgoingMessage) => sidebar.post(message)
  try {
    const extension = vscode.extensions.getExtension('local.helix-vscode')!
    sidebar = new SidebarProvider(extension.extensionUri, state, async (message) => {
      if (message.type === 'ready') controller!.replayPendingQuestions()
      if (message.type === 'questionAnswer') await controller!.answerQuestion(message)
      if (message.type === 'cancelTurn') await controller!.cancelTurn()
    })
    controller = new SessionController({ runtime, sidebar,
      changeTracker: { start: () => undefined, finish: () => undefined } as unknown as WorkspaceChangeTracker,
      getRuntimeState: () => runtime.currentState, getRuntimeOptions: async () => { throw new Error('Already started') },
      getEditorContext: () => undefined, getMaxSelectionCharacters: () => 32_000, getSelectedModelId: () => 'deepseek-v4-flash',
      resolveReasoningEffort: async () => undefined, rememberReasoningEffort: async () => undefined,
      onError: (error) => errors.push(String(error)), onStateChanged: () => post({ type: 'state', state: state(), resetTranscript: true }),
    })
    await runtime.start({ cwd: directory, dshHome: directory, sessionStorageRoot: join(directory, 'sessions'),
      provider: 'deepseek-official', model: 'deepseek-v4-flash', apiKey: 'local-smoke-only',
      baseUrl: `http://127.0.0.1:${address.port}`, sandboxMode: 'read-only', mcpServers: [] })
    panel = vscode.window.createWebviewPanel('helix-question-smoke', 'Helix Question Test', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true })
    sidebar.resolveWebviewView(panel as unknown as vscode.WebviewView)
    const version = await (await fetch('http://127.0.0.1:9339/json/version')).json() as any
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Inspector connection failed')), { once: true }) })
    ui = new Inspector(socket)
    const attached = new Set<string>()
    let pageSession: string | undefined
    const discover = async () => {
      const targets = await ui!.request('Target.getTargets')
      for (const target of targets.targetInfos) {
        if (!['page', 'iframe', 'webview'].includes(target.type) || attached.has(target.targetId)) continue
        const { sessionId } = await ui!.request('Target.attachToTarget', { targetId: target.targetId, flatten: true })
        attached.add(target.targetId)
        if (target.type === 'page') pageSession ??= sessionId
        await ui!.request('Runtime.enable', {}, sessionId)
      }
    }
    let context: { id: number; sessionId: string } | undefined
    await until(async () => {
      await discover()
      for (const candidate of ui!.contexts) {
        try {
          if (await ui!.evaluate(candidate, '!!document.querySelector("textarea[aria-label=Prompt]")')) { context = candidate; return true }
        } catch { /* Other workbench contexts may disappear. */ }
      }
      return false
    })
    const evaluate = (expression: string) => ui!.evaluate(context!, expression)
    await evaluate('(() => { const input=document.querySelector("textarea[aria-label=Prompt]");input.value="Keep this draft";input.dispatchEvent(new Event("input", {bubbles:true})); })()')
    assert.equal(await controller.submit('Ask a question before making changes.', false), true)
    await until(async () => !!await evaluate('document.querySelector("[data-question-request]")'))
    assert.equal(bodies.length, 1, JSON.stringify(errors))
    assert.equal(await evaluate('document.querySelectorAll("[data-question-request] input:checked").length'), 0)
    assert.equal(await evaluate('document.querySelector("[data-question-request] button[type=submit]").disabled'), true)
    assert.equal(await evaluate('document.querySelector(".composer-box").classList.contains("working")'), false)
    assert.equal(await evaluate('document.querySelector("[data-question-request] .badge").textContent'), 'Recommended')
    assert.equal(await evaluate('document.querySelectorAll("article.tool").length'), 1, 'No duplicate tool card')
    await until(async () => await evaluate('getComputedStyle(document.querySelector("article.tool")).opacity') === '1')
    await evaluate('document.querySelector(".shell").style.width="300px"')
    assert.equal(await evaluate('document.querySelector(".user-question").scrollWidth <= document.querySelector(".user-question").clientWidth'), true, 'Question card must fit a narrow sidebar')
    const screenshot = await ui.request('Page.captureScreenshot', { format: 'png' }, pageSession).catch(() => undefined)
    if (screenshot?.data) await writeFile('/tmp/helix-question-card.png', Buffer.from(screenshot.data, 'base64'))
    // Recreate the webview and replay the host-owned pending request.
    const previousWorlds = new Set(ui.contexts.map((world) => `${world.sessionId}:${world.id}`))
    const html = panel.webview.html
    panel.webview.html = ''
    panel.webview.html = html
    post({ type: 'state', state: state(), resetTranscript: true })
    context = undefined
    await until(async () => {
      await discover()
      for (const candidate of [...ui!.contexts].reverse()) {
        if (previousWorlds.has(`${candidate.sessionId}:${candidate.id}`)) continue
        try {
          if (await ui!.evaluate(candidate, '!!document.querySelector("[data-question-request]")')) { context = candidate; return true }
        } catch { /* Reload invalidates old worlds. */ }
      }
      return false
    })
    assert.equal(controller.questions.length, 1)
    await evaluate(`document.querySelector('[data-question-request] input[value="0"]').focus()`)
    for (const key of [' ', 'ArrowDown']) {
      await ui.request('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: key === ' ' ? 32 : 40 }, context!.sessionId)
      await ui.request('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: key === ' ' ? 32 : 40 }, context!.sessionId)
    }
    await until(async () => await evaluate(`document.querySelector('[data-question-request] input:checked')?.value`) === '1')
    await until(async () => !await evaluate('document.querySelector("[data-question-request] button[type=submit]").disabled'))
    await evaluate('document.querySelector("[data-question-request] button[type=submit]").click()')
    await until(() => bodies.length === 2)
    assert.ok(bodies[1].messages.some((message: any) => message.role === 'tool' && message.content.includes('All projects')))
    await until(async () => !!await evaluate('document.querySelector(".question-answer")'))
    assert.equal(controller.questions.length, 0)
    // A second call exercises custom input and draft preservation while waiting.
    await until(async () => await evaluate(`!document.querySelector('button[aria-label="Stop generation"]')`))
    stage = 'custom'
    await evaluate('(() => {const input=document.querySelector("textarea[aria-label=Prompt]");input.value="Keep this draft";input.dispatchEvent(new Event("input", {bubbles:true}));})()')
    await controller.submit('Ask again; do not assume the next answer.', false)
    await until(() => controller!.questions.length === 1)
    await until(async () => await evaluate('document.querySelectorAll("[data-question-request] form").length') === 1)
    await evaluate('document.querySelector("[data-question-request] form input[value=custom]").click()')
    assert.equal(await evaluate('document.querySelector("[data-question-request] form button[type=submit]").disabled'), true)
    await evaluate(`(() => {const input=document.querySelector('textarea[aria-label="Custom response"]');input.value="Only test files";input.dispatchEvent(new Event("input", {bubbles:true}));})()`)
    assert.equal(await evaluate('document.querySelector("textarea[aria-label=Prompt]").value'), 'Keep this draft')
    const beforeAnswer = bodies.length
    await evaluate('document.querySelector("textarea[aria-label=Prompt]").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",bubbles:true,cancelable:true}))')
    assert.equal(controller.questions.length, 1, 'Composer Enter must not cancel the question')
    await evaluate('document.querySelector("[data-question-request] form button[type=submit]").click()')
    await until(() => bodies.length === beforeAnswer + 1)
    assert.ok(bodies.at(-1).messages.some((message: any) => message.role === 'tool' && message.content.includes('Only test files')))
    await until(async () => await evaluate(`!document.querySelector('button[aria-label="Stop generation"]')`))
    // Stop must settle the question without starting another model request.
    stage = 'stop'
    await controller.submit('Ask once more.', false)
    await until(() => controller!.questions.length === 1)
    const beforeStop = bodies.length
    await evaluate(`document.querySelector('button[aria-label="Stop generation"]').click()`)
    await until(() => controller!.questions.length === 0)
    await until(async () => !!await evaluate('document.querySelector(".question-ended")'))
    assert.equal(bodies.length, beforeStop)
    await writeFile('/tmp/helix-question-smoke-result.json', JSON.stringify({ passed: true, vscode: vscode.version,
      checks: ['real DSH blocking tool', 'exact selected answer', 'custom answer', 'single tool card', 'recommendation', 'no default selection', 'keyboard radio navigation', 'narrow sidebar', 'draft preservation', 'composer Enter blocked', 'webview replay', 'Stop cancellation'], errors }, null, 2))
  } catch (error) {
    await writeFile('/tmp/helix-question-smoke-result.json', JSON.stringify({ passed: false, error: error instanceof Error ? error.stack : String(error), errors,
      requests: bodies.length, tools: bodies[0]?.tools?.map((tool: any) => tool.function?.name),
      toolResults: bodies.slice(0, 3).map((body) => body.messages?.filter((message: any) => message.role === 'tool')) }, null, 2))
    throw error
  } finally {
    ui?.close()
    await controller?.dispose()
    panel?.dispose()
    await runtime.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
