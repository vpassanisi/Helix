import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePlanReviewQuestion, validateQuestionAnswer, type UserQuestion } from '../shared/user-question.js'
import { DshQuestionBridge } from '../runtime/dsh-question-bridge.js'

const plan = '# Tighten the settings header\n\n- `padding: 4px 14px`\n- `align-items: center`\n'

/** Exactly what `exit_plan_mode` puts on the wire. */
const review = {
  id: 'plan-review', header: 'Plan review', question: 'Approve this plan and leave plan mode?', detail: plan,
  options: [{ label: 'Approve', description: 'Leave plan mode; carry out the plan from the next step.' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review', approve: 'Approve', callId: 'plan-call-1' },
}

const plainQuestion: UserQuestion = { id: 'scope', question: 'Where should this apply?', options: [
  { label: 'Current project (Recommended)' }, { label: 'All projects' },
] }

test('keeps the asker\'s own labels, the approve label, and the whole plan', () => {
  const normalized = validatePlanReviewQuestion(review)
  assert.deepEqual(normalized, {
    id: 'plan-review', header: 'Plan review', question: 'Approve this plan and leave plan mode?', detail: plan,
    options: review.options, intent: 'plan-review', approveLabel: 'Approve',
  })
  assert.deepEqual(validatePlanReviewQuestion(normalized), normalized, 'the Host re-validates the question the bridge forwarded')
})

test('rejects a review that is not a plan review before presenting it', () => {
  for (const value of [
    {}, undefined, { ...review, intent: undefined }, { ...review, intent: { kind: 'question', approve: 'Approve' } },
    { ...review, detail: undefined }, { ...review, detail: '  ' },
    { ...review, intent: { ...review.intent, approve: 'Ship it' } },
    { ...review, options: [...review.options, { label: 'Ask again later' }] },
    { ...review, options: [{ label: 'Approve' }, { label: 'Approve' }] },
    { ...review, options: [{ label: 'Approve' }, {}] },
    { ...review, multi_select: true }, { ...review, multiSelect: true },
    { ...review, id: '' }, { ...review, question: ' ' },
  ]) assert.throws(() => validatePlanReviewQuestion(value))
  assert.throws(() => validatePlanReviewQuestion(plainQuestion), /plan-review intent/)
})

test('answers must name an offered label verbatim or send nonempty feedback', () => {
  const question = validatePlanReviewQuestion(review)
  assert.deepEqual(validateQuestionAnswer(question, { id: 'plan-review', selected: ['Approve'] }),
    { id: 'plan-review', selected: ['Approve'] })
  assert.deepEqual(validateQuestionAnswer(question, { id: 'plan-review', selected: [], custom: '  Bump the version first  ' }),
    { id: 'plan-review', selected: [], custom: 'Bump the version first' })
  for (const value of [
    { id: 'plan-review', selected: ['Ship it'] }, { id: 'scope', selected: ['Approve'] },
    { id: 'plan-review', selected: [] }, { id: 'plan-review', selected: [], custom: ' ' },
    { id: 'plan-review', selected: ['Approve'], custom: 'and ship it' },
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
  const noAnswerer = async () => { throw new Error('no user-questions answerer accepted the request') }
  const ask = (question = review, signal: AbortSignal = abort.signal) =>
    bridge.request({ questions: [structuredClone(question)], agent: root, signal }, noAnswerer)
  const lastRequestId = () => String([...events].reverse().find((event) => event.method === 'question.request')!.params.requestId)
  return { bridge, events, abort, ask, lastRequestId, noAnswerer, child, cancelled: () => cancelled }
}

test('the plan review is claimed with no tool execution to gate on', async () => {
  const f = fixture()
  const run = f.ask()
  await Promise.resolve()
  const request = f.events[0]
  assert.equal(request.method, 'question.request')
  assert.equal(request.params.toolCallId, 'plan-call-1')
  assert.deepEqual((request.params.question as Record<string, unknown>).detail, plan)
  assert.equal((request.params.question as Record<string, unknown>).approveLabel, 'Approve')
  f.bridge.answer('root', String(request.params.requestId), { id: 'plan-review', selected: ['Approve'] })
  assert.deepEqual(await run, { answers: [{ id: 'plan-review', selected: ['Approve'] }] })
})

test('feedback travels as the custom answer the model reads as a plan revision request', async () => {
  const f = fixture()
  const run = f.ask()
  f.bridge.answer('root', String(f.events[0].params.requestId), { id: 'plan-review', selected: [], custom: 'Split the CSS change from the version bump.' })
  assert.deepEqual(await run, { answers: [{ id: 'plan-review', selected: [], custom: 'Split the CSS change from the version bump.' }] })
})

test('one review per agent, and the next review is accepted after one settles', async () => {
  const f = fixture()
  const first = f.ask()
  await assert.rejects(f.ask(), /already running/)
  f.bridge.answer('root', String(f.events[0].params.requestId), { id: 'plan-review', selected: ['Approve'] })
  await first
  const second = f.ask()
  f.bridge.answer('root', f.lastRequestId(), { id: 'plan-review', selected: [], custom: 'Skip the CSS tweak.' })
  assert.deepEqual(await second, { answers: [{ id: 'plan-review', selected: [], custom: 'Skip the CSS tweak.' }] })
})

test('aborting the review releases the wait and cancels nothing twice', async () => {
  const f = fixture()
  const run = f.ask()
  const rejected = assert.rejects(run, /cancelled/)
  f.abort.abort()
  await rejected
  assert.equal(f.events[1].method, 'question.resolved')
  assert.equal(f.events[1].params.status, 'cancelled')
})

test('disposal answers nobody and frees the review slot', async () => {
  const f = fixture()
  const run = f.ask()
  const rejected = assert.rejects(run)
  f.bridge.dispose()
  await rejected
  assert.equal(f.cancelled(), 1)
  const next = f.ask(review, new AbortController().signal)
  f.bridge.answer('root', f.lastRequestId(), { id: 'plan-review', selected: ['Approve'] })
  assert.deepEqual((await next).answers[0].selected, ['Approve'])
})

test('a child agent cannot ask for a plan review, and plain questions keep their own gate', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.request({ questions: [structuredClone(review)], agent: f.child, signal: f.abort.signal }, f.noAnswerer), /main agent/)
  const fellThrough = await f.bridge.request({ questions: [plainQuestion], agent: f.child, signal: f.abort.signal }, async () => 'next answerer')
  assert.equal(fellThrough, 'next answerer', 'an ask_user_question call with no execution of ours stays with the next answerer')
  assert.equal(f.events.length, 0)
})

test('a review with no plan text fails the bridge instead of showing an empty card', async () => {
  const f = fixture()
  await assert.rejects(f.ask({ ...review, detail: '' }))
  assert.equal(f.events.length, 0)
})
