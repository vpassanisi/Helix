import assert from 'node:assert/strict'
import test from 'node:test'
import { validateQuestionCall, validateQuestionAnswer, optionDisplayLabel, type UserQuestion } from '../shared/user-question.js'
import { DshQuestionBridge } from '../runtime/dsh-question-bridge.js'
import helixControlPlugin from '../runtime/dsh-control-plugin.js'
import { LocalControlBridge, type ControlEvent } from '../runtime/control-bridge.js'

const question: UserQuestion = { id: 'scope', question: 'Where should this apply?', options: [
  { label: 'Current project (Recommended)', description: 'Change this project only.' }, { label: 'All projects' },
] }

test('accepts two or three choices and preserves canonical recommended labels', () => {
  assert.deepEqual(validateQuestionCall({ questions: [question] }), question)
  assert.equal(validateQuestionCall({ questions: [{ ...question, options: [...question.options, { label: 'Future projects' }] }] }).options.length, 3)
  assert.equal(optionDisplayLabel(question.options[0].label), 'Current project')
})

const malformed = [
  {}, { questions: [] }, { questions: [question, question] },
  { questions: [{ ...question, id: '' }] }, { questions: [{ ...question, question: ' ' }] },
  { questions: [{ ...question, options: undefined }] }, { questions: [{ ...question, options: [question.options[0]] }] },
  { questions: [{ ...question, options: [...question.options, { label: 'C' }, { label: 'D' }] }] },
  { questions: [{ ...question, options: [{ label: 'A' }, { label: 'B' }] }] },
  { questions: [{ ...question, options: [{ label: 'A (Recommended)' }, { label: 'B (Recommended)' }] }] },
  { questions: [{ ...question, options: [{ label: 'A' }, { label: 'B (Recommended)' }] }] },
  { questions: [{ ...question, options: [{ label: 'A (Recommended)' }, { label: 'a' }] }] },
  { questions: [{ ...question, options: [{ label: '(Recommended)' }, { label: 'B' }] }] },
  { questions: [{ ...question, multi_select: true }] }, { questions: [{ ...question, multiSelect: true }] },
]
test('rejects malformed questions before presenting them', () => {
  for (const value of malformed) assert.throws(() => validateQuestionCall(value))
})

test('accepts only one known choice or nonempty exclusive custom text', () => {
  const selected = { id: question.id, selected: [question.options[0].label] }
  assert.deepEqual(validateQuestionAnswer(question, selected), selected)
  assert.deepEqual(validateQuestionAnswer(question, { id: question.id, selected: [], custom: '  Just this file  ' }),
    { id: question.id, selected: [], custom: 'Just this file' })
  for (const value of [
    { id: 'wrong', selected: [question.options[0].label] }, { id: question.id, selected: ['Unknown'] },
    { id: question.id, selected: question.options.map((option) => option.label) }, { id: question.id, selected: [] },
    { id: question.id, selected: [], custom: ' ' }, { ...selected, custom: 'Both' },
  ]) assert.throws(() => validateQuestionAnswer(question, value))
})

function fixture() {
  const abort = new AbortController()
  let cancelled = 0
  const root = { id: 'root', cancel: () => { cancelled++; abort.abort() } }
  const child = { id: 'child' }
  const agents = new Map([['root', root], ['child', child]])
  const ctx = { get: () => ({ get: (id: string) => agents.get(id), roots: () => [root] }) }
  const events: Array<{ sessionId: string; method: string; params: Record<string, unknown> }> = []
  const bridge = new DshQuestionBridge(ctx, () => true, (sessionId, method, params) => { events.push({ sessionId, method, params }); return true })
  const exec = { name: 'ask_user_question', callId: 'call-123', agent: root, arguments: { questions: [question] }, signal: abort.signal }
  const start = () => bridge.execute(exec, () => bridge.request({ questions: [question], agent: root, signal: abort.signal }, async () => { throw new Error('No provider') }))
  return { bridge, events, exec, start, abort, child, cancelled: () => cancelled }
}

test('blocks the continuation until an exact answer arrives and resolves only once', async () => {
  const f = fixture()
  let continued = false
  const run = f.start().then((answer) => { continued = true; return answer })
  await Promise.resolve()
  assert.equal(continued, false)
  assert.equal(f.events[0].params.toolCallId, 'call-123')
  const requestId = String(f.events[0].params.requestId)
  assert.throws(() => f.bridge.answer('another-session', requestId, { id: question.id, selected: [question.options[0].label] }))
  assert.throws(() => f.bridge.answer('root', requestId, { id: question.id, selected: ['Unknown'] }))
  assert.equal(continued, false)
  const answer = { id: question.id, selected: [question.options[0].label] }
  f.bridge.answer('root', requestId, answer)
  assert.deepEqual(await run, { answers: [answer] })
  assert.equal(continued, true)
  assert.throws(() => f.bridge.answer('root', requestId, answer), /no longer pending/)
  assert.equal(f.events.filter((event) => event.method === 'question.resolved').length, 1)
})

test('returns custom text in the native DSH result shape', async () => {
  const f = fixture()
  const run = f.start()
  f.bridge.answer('root', String(f.events[0].params.requestId), { id: question.id, selected: [], custom: 'Only tests' })
  assert.deepEqual(await run, { answers: [{ id: question.id, selected: [], custom: 'Only tests' }] })
})

test('Stop aborts the wait without answering', async () => {
  const f = fixture()
  const run = f.start()
  const rejected = assert.rejects(run, /cancelled/)
  f.abort.abort()
  await rejected
  assert.equal(f.events[1].params.status, 'cancelled')
})

test('disconnect and disposal cancel the asking turn and release all waits', async () => {
  for (const action of ['disconnect', 'dispose'] as const) {
    const f = fixture()
    const run = f.start()
    const rejected = assert.rejects(run)
    f.bridge[action]()
    await rejected
    assert.equal(f.cancelled(), 1)
    assert.equal(f.events.filter((event) => event.method === 'question.resolved').length, 1)
  }
})

test('child and stale agent instances cannot ask, and unrelated tools are unaffected', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.execute({ ...f.exec, agent: f.child }, async () => 'unused'), /main agent/)
  await assert.rejects(f.bridge.execute({ ...f.exec, agent: { id: 'root' } }, async () => 'unused'), /main agent/)
  assert.equal(await f.bridge.execute({ name: 'read_file' }, async () => 'read'), 'read')
  assert.equal(f.events.length, 0)
})

test('answers travel over the authenticated plugin bridge', async () => {
  const events: ControlEvent[] = []
  const bridge = new LocalControlBridge({ onEvent: (event) => events.push(event) })
  await bridge.start()
  const previousEndpoint = process.env.HELIX_CONTROL_ENDPOINT
  const previousToken = process.env.HELIX_CONTROL_TOKEN
  process.env.HELIX_CONTROL_ENDPOINT = bridge.endpoint
  process.env.HELIX_CONTROL_TOKEN = bridge.token
  const handlers = new Map<string, (...args: any[]) => any>()
  const abort = new AbortController()
  const root = { id: 'root', cancel: () => abort.abort() }
  let dispose: (() => void) | undefined
  try {
    helixControlPlugin({ get: (name: string) => name === 'agents' ? { get: (id: string) => id === 'root' ? root : undefined, roots: () => [root] } : undefined,
      on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
      effect: (factory: () => () => void) => { dispose = factory() } })
    assert.equal(await bridge.waitForConnection(), true)
    await bridge.request('capabilities.get', 'root')
    assert.ok(bridge.capabilities.includes('question.answer'))
    const run = handlers.get('tools/execute')!({ name: 'ask_user_question', callId: 'wire-call', agent: root,
      arguments: { questions: [question] }, signal: abort.signal }, () =>
      handlers.get('user-questions/request')!({ questions: [question], agent: root, signal: abort.signal }, async () => { throw new Error('No answerer') }))
    await waitFor(() => events.some((event) => event.method === 'question.request'))
    const request = events.find((event) => event.method === 'question.request')!
    assert.equal(request.params.toolCallId, 'wire-call')
    const answer = { id: question.id, selected: [question.options[1].label] }
    await bridge.answerQuestion('root', String(request.params.requestId), answer)
    assert.deepEqual(await run, { answers: [answer] })
    await waitFor(() => events.some((event) => event.method === 'question.resolved'))
    await assert.rejects(bridge.answerQuestion('root', String(request.params.requestId), answer), /no longer pending/)
  } finally {
    dispose?.()
    await bridge.close()
    if (previousEndpoint === undefined) delete process.env.HELIX_CONTROL_ENDPOINT
    else process.env.HELIX_CONTROL_ENDPOINT = previousEndpoint
    if (previousToken === undefined) delete process.env.HELIX_CONTROL_TOKEN
    else process.env.HELIX_CONTROL_TOKEN = previousToken
  }
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Question bridge test timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
