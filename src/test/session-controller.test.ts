import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionController } from '../host/session-controller.js'
import type { HarnessRuntime } from '../runtime/harness-runtime.js'
import type { WorkspaceChangeTracker } from '../runtime/change-tracker.js'
import type { SidebarProvider, SidebarOutgoingMessage } from '../sidebar/sidebar-provider.js'

function controllerWithPrompt(prompt: () => Promise<void>) {
  const calls: string[] = []
  const messages: SidebarOutgoingMessage[] = []
  const remembered: Array<[string, string | undefined]> = []
  const errors: string[] = []
  const runtime = {
    registerSession: () => ({ dispose: () => undefined }),
    setReasoningEffort: async (_sessionId: string, effort: string | null) => { calls.push(`set:${effort}`) },
    prompt: async () => { calls.push('prompt'); await prompt() },
    cancelTurn: async () => undefined,
  } as unknown as HarnessRuntime
  const sidebar = { post: (message: SidebarOutgoingMessage) => { messages.push(message) } } as SidebarProvider
  const changeTracker = { finish: () => undefined } as unknown as WorkspaceChangeTracker
  const controller = new SessionController({
    runtime,
    sidebar,
    changeTracker,
    getRuntimeState: () => 'ready',
    getRuntimeOptions: async () => { throw new Error('The ready runtime needs no startup options.') },
    getEditorContext: () => undefined,
    getMaxSelectionCharacters: () => 32_000,
    getSelectedModelId: () => 'model-a',
    resolveReasoningEffort: async () => 'low',
    rememberReasoningEffort: async (modelId, effort) => { calls.push('remember'); remembered.push([modelId, effort]) },
    onError: (error) => { errors.push(String(error)) },
    onStateChanged: () => undefined,
  })
  return { controller, calls, messages, remembered, errors }
}

test('remembers the resolved effort only after the prompt is accepted', async () => {
  const { controller, calls, messages, remembered, errors } = controllerWithPrompt(async () => undefined)
  await controller.submit('Hello', false, 'low')
  assert.deepEqual(calls, ['set:low', 'prompt', 'remember'])
  assert.deepEqual(remembered, [['model-a', 'low']])
  assert.equal(controller.currentReasoningEffort, 'low')
  assert.equal(messages.find((message) => message.type === 'accepted')?.type, 'accepted')
  assert.deepEqual(errors, [])
  await controller.dispose()
})

test('a failed prompt does not replace the last-used effort', async () => {
  const { controller, calls, messages, remembered, errors } = controllerWithPrompt(async () => {
    throw new Error('prompt failed')
  })
  await controller.submit('Hello', false, 'low')
  assert.deepEqual(calls, ['set:low', 'prompt'])
  assert.deepEqual(remembered, [])
  assert.equal(controller.currentReasoningEffort, undefined)
  assert.equal(messages.some((message) => message.type === 'accepted'), false)
  assert.match(errors[0] ?? '', /prompt failed/)
  await controller.dispose()
})
