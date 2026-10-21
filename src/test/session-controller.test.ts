import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionController } from '../host/session-controller.js'
import type { HarnessRuntime } from '../runtime/harness-runtime.js'
import type { RoutedNotification } from '../runtime/types.js'
import type { WorkspaceChangeTracker } from '../runtime/change-tracker.js'
import type { SidebarProvider, SidebarOutgoingMessage } from '../sidebar/sidebar-provider.js'

function controllerWithPrompt(prompt: () => Promise<void>, waitForSession: () => Promise<void> = async () => undefined) {
  const calls: string[] = []
  const messages: SidebarOutgoingMessage[] = []
  const remembered: Array<[string, string | undefined]> = []
  const errors: string[] = []
  let sessionRouteHandler: ((routed: RoutedNotification) => void) | undefined
  const runtime = {
    registerSession: (rootSessionId: string, handler: (routed: RoutedNotification) => void) => {
      sessionRouteHandler = handler
      return { dispose: () => { if (sessionRouteHandler === handler) sessionRouteHandler = undefined } }
    },
    setReasoningEffort: async (_sessionId: string, effort: string | null) => { calls.push(`set:${effort}`) },
    prompt: async () => { calls.push('prompt'); await prompt() },
    waitForSession: async (sessionId: string) => { calls.push(`wait:${sessionId}`); await waitForSession() },
    cancelTurn: async () => undefined,
  } as unknown as HarnessRuntime
  const sidebar = { post: (message: SidebarOutgoingMessage) => { messages.push(message) } } as SidebarProvider
  const changeTracker = { start: () => undefined, finish: () => undefined } as unknown as WorkspaceChangeTracker
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
  const emitNotification = (notification: RoutedNotification['notification']) => {
    const sessionId = typeof notification.params.sessionId === 'string'
      ? notification.params.sessionId
      : controller.currentSessionId
    sessionRouteHandler?.({ rootSessionId: controller.currentSessionId, sessionId, notification })
  }
  return { controller, calls, messages, remembered, errors, runtime, emitNotification }
}

function sessionStatuses(messages: SidebarOutgoingMessage[]): unknown[] {
  return messages.flatMap((message) => {
    if (message.type !== 'notification') return []
    const notification = message.notification as RoutedNotification['notification']
    return notification.method === 'session.status' ? [notification.params.status] : []
  })
}

test('remembers the resolved effort only after the prompt is accepted', async () => {
  const { controller, calls, messages, remembered, errors } = controllerWithPrompt(async () => undefined)
  await controller.submit('Hello', false, 'low')
  assert.deepEqual(calls, ['set:low', 'prompt', `wait:${controller.currentSessionId}`, 'remember'])
  assert.deepEqual(remembered, [['model-a', 'low']])
  assert.equal(controller.currentReasoningEffort, 'low')
  assert.equal(messages.find((message) => message.type === 'accepted')?.type, 'accepted')
  assert.deepEqual(errors, [])
  await controller.dispose()
})

test('holds root idle status until session/wait includes managed descendants', async () => {
  let resolveWait!: () => void
  const wait = new Promise<void>((resolve) => { resolveWait = resolve })
  const { controller, messages, emitNotification } = controllerWithPrompt(async () => undefined, () => wait)
  const sessionId = controller.currentSessionId
  await controller.submit('Delegate this task', false)

  emitNotification({ method: 'session.status', params: { sessionId, status: 'running' } })
  emitNotification({ method: 'session.status', params: { sessionId, status: 'idle' } })
  emitNotification({ method: 'subagent.started', params: { parentSessionId: sessionId, childSessionId: 'child-1' } })

  assert.deepEqual(sessionStatuses(messages), ['running'])
  assert.equal(messages.some((message) => message.type === 'notification' &&
    (message.notification as RoutedNotification['notification']).method === 'subagent.started'), true)

  resolveWait()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(sessionStatuses(messages), ['running', 'idle'])
  await controller.dispose()
})

test('surfaces session/wait failures and releases a deferred root status', async () => {
  let rejectWait!: (error: Error) => void
  const wait = new Promise<void>((_resolve, reject) => { rejectWait = reject })
  const { controller, messages, errors, emitNotification } = controllerWithPrompt(async () => undefined, () => wait)
  const sessionId = controller.currentSessionId
  await controller.submit('Run a task', false)
  emitNotification({ method: 'session.status', params: { sessionId, status: 'idle' } })
  assert.deepEqual(sessionStatuses(messages), [])

  rejectWait(new Error('wait failed'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(errors[0] ?? '', /wait failed/)
  assert.deepEqual(sessionStatuses(messages), ['idle'])
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

const userQuestion = { id: 'scope', question: 'Where should this apply?', options: [
  { label: 'This project (Recommended)' }, { label: 'Every project' },
] }

function questionEvent(sessionId: string, requestId = 'question-1') {
  return { eventId: 'event-1', sessionId, method: 'question.request' as const,
    params: { requestId, toolCallId: 'tool-1', question: userQuestion } }
}

test('pending questions are session-owned, block submission, and replay without invoking the runtime', async () => {
  const { controller, runtime, messages, calls } = controllerWithPrompt(async () => undefined)
  let replies = 0
  runtime.answerQuestion = async () => { replies++ }
  controller.handleControlEvent(questionEvent('another-session'))
  assert.equal(controller.questions.length, 0)
  controller.handleControlEvent(questionEvent(controller.currentSessionId))
  controller.handleControlEvent(questionEvent(controller.currentSessionId))
  assert.equal(controller.questions.length, 1)
  assert.equal(messages.filter((message) => message.type === 'questionRequest').length, 1)
  controller.replayPendingQuestions()
  assert.equal(messages.filter((message) => message.type === 'questionRequest').length, 2)
  assert.equal(await controller.submit('Do something else', false), false)
  assert.deepEqual(calls, [])
  await controller.answerQuestion({ type: 'questionAnswer', sessionId: 'another-session', requestId: 'question-1', answer: { id: 'scope', selected: ['Every project'] } })
  assert.equal(replies, 0)
  await controller.cancelTurn()
  assert.equal(controller.questions.length, 0)
  assert.equal(messages.at(-1)?.type, 'questionResolved')
  await controller.dispose()
})

test('idle status keeps a pending user question available for its answer', async () => {
  const { controller, messages, emitNotification } = controllerWithPrompt(async () => undefined)
  const sessionId = controller.currentSessionId
  controller.handleControlEvent(questionEvent(sessionId))

  emitNotification({ method: 'session.status', params: { sessionId, status: 'idle' } })

  assert.equal(controller.questions.length, 1)
  assert.equal(messages.some((message) => message.type === 'questionResolved'), false)
  await controller.cancelTurn()
  await controller.dispose()
})

test('answer failures preserve the pending card and permit retry; resolution is authoritative', async () => {
  const { controller, runtime, messages } = controllerWithPrompt(async () => undefined)
  const sessionId = controller.currentSessionId
  controller.handleControlEvent(questionEvent(sessionId))
  let replies = 0
  runtime.answerQuestion = async () => { replies++; if (replies === 1) throw new Error('Temporary failure') }
  const answer = { id: 'scope', selected: ['Every project'] }
  const reply = { type: 'questionAnswer' as const, sessionId, requestId: 'question-1', answer }
  await controller.answerQuestion({ ...reply, answer: { id: 'scope', selected: ['Unknown'] } })
  assert.equal(replies, 0)
  await controller.answerQuestion(reply)
  assert.equal(messages.at(-1)?.type, 'questionAnswerFailed')
  assert.equal(controller.questions.length, 1)
  await controller.answerQuestion(reply)
  await controller.answerQuestion(reply)
  assert.equal(replies, 2, 'Duplicate submissions cannot resolve again')
  assert.equal(controller.questions.length, 1, 'Acknowledgement is not the authoritative resolution')
  controller.handleControlEvent({ eventId: 'resolved', sessionId, method: 'question.resolved', params: { requestId: 'question-1', status: 'answered', answer } })
  assert.equal(controller.questions.length, 0)
  assert.equal(messages.at(-1)?.type, 'questionResolved')
  await controller.answerQuestion(reply)
  assert.equal(replies, 2)
  await controller.dispose()
})

test('New Session and disposal clear pending questions', async () => {
  for (const action of ['newSession', 'dispose'] as const) {
    const { controller, messages } = controllerWithPrompt(async () => undefined)
    const oldSession = controller.currentSessionId
    controller.handleControlEvent(questionEvent(oldSession))
    await controller[action]()
    assert.equal(controller.questions.length, 0)
    assert.equal(messages.some((message) => message.type === 'questionResolved' && message.status === 'cancelled'), true)
    if (action === 'newSession') assert.notEqual(controller.currentSessionId, oldSession)
    await controller.dispose()
  }
})
