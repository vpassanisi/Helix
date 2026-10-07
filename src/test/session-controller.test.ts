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
  return { controller, calls, messages, remembered, errors, runtime }
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
