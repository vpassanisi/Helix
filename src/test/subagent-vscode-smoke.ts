/// <reference lib="dom" />
// Run explicitly in an isolated VS Code Extension Development Host, never Chrome.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { SessionController } from '../host/session-controller.js'
import { HarnessRuntime } from '../runtime/harness-runtime.js'
import type { SidebarMessage, SidebarOutgoingMessage, SidebarProvider } from '../sidebar/sidebar-provider.js'
import type { RoutedNotification, RuntimeOptions } from '../runtime/types.js'
import type { WorkspaceChangeTracker } from '../runtime/change-tracker.js'

const CHILD_PROMPT = 'HELIX_SUBAGENT_CHILD_TASK_7291'

export async function run(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-subagent-smoke-'))
  const requests: Array<{ child: boolean; body: any }> = []
  const rawNotifications: RoutedNotification[] = []
  const messages: SidebarOutgoingMessage[] = []
  const errors: string[] = []
  let rootToolCallIssued = false
  let waitRequested = false
  let waitSettled = false
  let releaseChild!: () => void
  let childRequestStarted!: () => void
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve })
  const childRequest = new Promise<void>((resolve) => { childRequestStarted = resolve })
  const server = createServer(async (request, response) => {
    try {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      const child = (body.messages ?? []).some((message: any) => message.role === 'user' &&
        (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).includes(CHILD_PROMPT))
      requests.push({ child, body })
      let delta: unknown
      let finishReason: string
      if (!child && !rootToolCallIssued) {
        rootToolCallIssued = true
        const toolNames = (body.tools ?? []).map((tool: any) => tool.function?.name)
        assert.ok(toolNames.includes('subagent'), `SDK profile did not expose subagent: ${JSON.stringify(toolNames)}`)
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'helix-subagent-call', type: 'function', function: {
          name: 'subagent', arguments: JSON.stringify({ description: 'Inspect the workspace', prompt: CHILD_PROMPT }),
        } }] }
        finishReason = 'tool_calls'
      } else if (child) {
        childRequestStarted()
        await childGate
        delta = { role: 'assistant', content: 'Child completed the delegated task.' }
        finishReason = 'stop'
      } else {
        delta = { role: 'assistant', content: 'Parent continued while the child ran.' }
        finishReason = 'stop'
      }
      const chunk = (value: unknown, reason: string | null) => `data: ${JSON.stringify({ id: 'helix-subagent-smoke', object: 'chat.completion.chunk', created: 1,
        model: 'test/subagent-smoke-model', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(chunk(delta, null) + chunk({}, finishReason) + 'data: [DONE]\n\n')
    } catch (error) {
      response.writeHead(500)
      response.end()
      errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const options: RuntimeOptions = {
    cwd: directory,
    dshHome: directory,
    sessionStorageRoot: join(directory, 'sessions'),
    provider: 'helix-subagent-smoke',
    model: 'test/subagent-smoke-model',
    savedModels: [{ id: 'test/subagent-smoke-model' }],
    apiKey: 'local-smoke-only',
    baseUrl,
    sandboxMode: 'read-only',
    mcpServers: [],
  }
  const runtime = new HarnessRuntime({ onLifecycleError: (error) => errors.push(String(error)) })
  let sidebar: SidebarProvider
  const fakeSidebar = { post: (message: SidebarOutgoingMessage) => { messages.push(message) } }
  sidebar = fakeSidebar as unknown as SidebarProvider
  const controller = new SessionController({
    runtime,
    sidebar,
    changeTracker: { start: () => undefined, finish: () => undefined } as unknown as WorkspaceChangeTracker,
    getRuntimeState: () => runtime.currentState,
    getRuntimeOptions: async () => options,
    getEditorContext: () => undefined,
    getMaxSelectionCharacters: () => 32_000,
    getSelectedModelId: () => options.model,
    resolveReasoningEffort: async () => undefined,
    rememberReasoningEffort: async () => undefined,
    onError: (error) => errors.push(String(error)),
    onStateChanged: () => undefined,
  })
  const sessionId = controller.currentSessionId
  const observer = runtime.registerSession(sessionId, (event) => rawNotifications.push(event))
  const waitForSession = runtime.waitForSession.bind(runtime)
  runtime.waitForSession = async (id) => {
    waitRequested = true
    await waitForSession(id)
    waitSettled = true
  }

  try {
    assert.ok(vscode.version)
    assert.equal(await controller.submit('ROOT_TASK_MARKER: delegate and keep working.', false), true)
    await until(async () => requests.some((entry) => entry.child))
    await until(() => waitRequested)
    await until(() => rawNotifications.some((event) => event.notification.method === 'subagent.started'))
    await childRequest
    assert.equal(waitSettled, false, 'session/wait must remain pending while a managed child runs')

    const rootRequest = requests.find((entry) => !entry.child)?.body
    assert.ok(rootRequest, 'The root agent must reach the model')
    assert.match(JSON.stringify(rootRequest.messages), /You are a coding agent/i, 'The SDK profile keeps its coding persona')
    const workspaceTools = (rootRequest.tools ?? []).map((tool: any) => tool.function?.name)
    assert.ok(workspaceTools.includes('working_directory') && workspaceTools.includes('read') && workspaceTools.includes('write'),
      `Workspace tools must remain available: ${JSON.stringify(workspaceTools)}`)

    const rootIdleBeforeRelease = messages.some((message) => isRootStatus(message, sessionId, 'idle'))
    assert.equal(rootIdleBeforeRelease, false, 'Root idle must stay hidden while session/wait is pending')
    assert.equal(messages.some((message) => isNotification(message, 'subagent.started')), true, 'Subagent notifications remain live')

    releaseChild()
    await until(() => waitSettled)
    await until(() => messages.some((message) => isRootStatus(message, sessionId, 'idle')))
    const finishedIndex = messages.findIndex((message) => isNotification(message, 'subagent.finished'))
    const idleIndex = messages.findIndex((message) => isRootStatus(message, sessionId, 'idle'))
    assert.ok(finishedIndex >= 0, 'The completed child must be surfaced')
    assert.ok(idleIndex > finishedIndex, 'Root idle must follow subagent completion')
    assert.deepEqual(errors, [])
    await import('node:fs/promises').then(({ writeFile }) => writeFile('/tmp/helix-subagent-smoke-result.json', JSON.stringify({
      passed: true,
      vscode: vscode.version,
      requests: requests.length,
      checks: ['coding persona retained', 'workspace tools available', 'sdk subagent tool available', 'live subagent notification',
        'wait pending during child work', 'root idle deferred', 'root idle after child completion'],
    }, null, 2)))
  } catch (error) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile('/tmp/helix-subagent-smoke-result.json', JSON.stringify({ passed: false, vscode: vscode.version,
      error: error instanceof Error ? error.stack : String(error), requests: requests.length,
      childRequests: requests.filter((entry) => entry.child).length,
      rawNotifications: rawNotifications.map((event) => ({ method: event.notification.method, sessionId: event.sessionId, params: event.notification.params })),
      messages: messages.map((message) => message.type === 'notification' ? ({ type: message.type, method: (message.notification as any).method,
        sessionId: message.sessionId, params: (message.notification as any).params }) : message), errors,
    }, null, 2))
    throw error
  } finally {
    releaseChild()
    observer.dispose()
    await controller.dispose()
    await runtime.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Subagent smoke test timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function isNotification(message: SidebarOutgoingMessage, method: string): boolean {
  return message.type === 'notification' && (message.notification as RoutedNotification['notification']).method === method
}

function isRootStatus(message: SidebarOutgoingMessage, sessionId: string, status: 'idle' | 'running'): boolean {
  if (message.type !== 'notification') return false
  const notification = message.notification as RoutedNotification['notification']
  return notification.method === 'session.status' && notification.params?.sessionId === sessionId && notification.params?.status === status
}
