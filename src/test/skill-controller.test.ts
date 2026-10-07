import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillController, type SkillControllerOptions } from '../host/skill-controller.js'
import type { SkillCatalog, SkillDraft, SkillSuggestions } from '../shared/skills.js'

const draft = (revision: number, prompt = 'build a form'): SkillDraft => ({ sessionId: 'session', revision, prompt, recentChat: [] })
const catalog: SkillCatalog = { revision: '1', complete: true, skills: ['one', 'two', 'manual-only'].map((name) => ({ name, description: name, modelInvocable: name !== 'manual-only', userInvocable: true })) }
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function setup(overrides: Partial<SkillControllerOptions> = {}) {
  const updates: SkillSuggestions[] = []
  const controller = new SkillController({ catalog: async () => catalog,
    connection: async () => ({ enabled: true, useMainConnection: false, format: 'typesafe', baseUrl: 'https://example.com', model: 'test', threshold: 0.75 }),
    currentSession: () => 'session', metadata: () => 'workspace', publish: (value) => updates.push(value), publishCatalog: () => undefined,
    decide: async (_connection, _input, skills) => skills.map((skill) => ({ skillId: skill.name, probability: skill.name === 'one' ? 0.75 : 0.74 })),
    debounceMs: 10, timeoutMs: 100, ...overrides })
  return { controller, updates }
}

test('debounce coalesces drafts, checks eligibility, and respects the threshold boundary', async () => {
  let calls = 0
  const { controller, updates } = setup({ decide: async (_connection, _input, skills) => {
    calls++; assert.deepEqual(skills.map((skill) => skill.name), ['one', 'two'])
    return [{ skillId: 'one', probability: 0.75 }, { skillId: 'two', probability: 0.74 }]
  } })
  controller.update(draft(1)); controller.update(draft(2)); controller.update(draft(3))
  await pause(50)
  assert.equal(calls, 1)
  assert.deepEqual(updates.at(-1)?.selected, ['one'])
  assert.equal(updates.at(-1)?.revision, 3)
  controller.invalidate()
})

test('obsolete uncooperative responses never replace current suggestions', async () => {
  let finishOld!: (value: Array<{ skillId: string; probability: number }>) => void
  const { controller, updates } = setup({ debounceMs: 0, decide: async (_connection, input) => input.includes('old draft')
    ? new Promise((resolve) => { finishOld = resolve }) : [{ skillId: 'two', probability: 1 }] })
  controller.update(draft(1, 'old draft'))
  await pause(10)
  controller.update(draft(2, 'new draft'))
  await pause(20)
  finishOld([{ skillId: 'one', probability: 1 }])
  await pause(10)
  assert.deepEqual(updates.at(-1)?.selected, ['two'])
  assert.equal(updates.at(-1)?.revision, 2)
  controller.invalidate()
})

test('send uses current results and manual overrides; model-only eligibility is respected', async () => {
  const { controller } = setup()
  const selection = await controller.freeze(draft(1), { include: ['manual-only'], exclude: ['one'] })
  assert.deepEqual(selection.include, ['manual-only'])
  assert.deepEqual(selection.exclude, ['one'])
  assert.deepEqual(selection.manual, ['manual-only'])
  controller.invalidate()
})

test('send deadline preserves completed batches and ignores late answers', async () => {
  const many: SkillCatalog = { revision: 'many', complete: true, skills: Array.from({ length: 65 }, (_, i) => ({ name: `skill-${i}`, description: '', modelInvocable: true, userInvocable: true })) }
  let resolveLate!: (value: Array<{ skillId: string; probability: number }>) => void
  const { controller } = setup({ timeoutMs: 500, sendTimeoutMs: 30, catalog: async () => many,
    decide: async (_connection, _input, skills) => skills[0]?.name === 'skill-0'
      ? skills.map((skill) => ({ skillId: skill.name, probability: 1 })) : new Promise((resolve) => { resolveLate = resolve }) })
  const selection = await controller.freeze(draft(1), { include: ['manual-skill'], exclude: ['skill-0'] })
  assert.equal(selection.include.length, 32)
  assert.ok(selection.include.includes('skill-31'))
  assert.ok(selection.include.includes('manual-skill'))
  resolveLate([{ skillId: 'skill-64', probability: 1 }])
  await pause(5)
  assert.equal(selection.include.includes('skill-64'), false)
  controller.invalidate()
})

test('blocked discovery has a bounded send deadline and still permits manual selection', async () => {
  const { controller } = setup({ timeoutMs: 500, sendTimeoutMs: 15, catalog: () => new Promise(() => undefined) })
  const selected = await controller.freeze(draft(1), { include: ['one'], exclude: [] })
  assert.deepEqual(selected.include, ['one'])
  controller.invalidate()
})

test('cache invalidation forces fresh decisions; only two batches run concurrently', async () => {
  let calls = 0; let concurrent = 0; let peak = 0
  const { controller } = setup({ timeoutMs: 500, catalog: async () => ({ ...catalog, skills: Array.from({ length: 100 }, (_, i) => ({ ...catalog.skills[0]!, name: `skill-${i}` })) }),
    decide: async (_connection, _input, skills) => { calls++; peak = Math.max(peak, ++concurrent); await pause(5); concurrent--; return skills.map((skill) => ({ skillId: skill.name, probability: 1 })) } })
  await controller.freeze(draft(1), { include: [], exclude: [] })
  controller.cancel()
  await controller.freeze(draft(2), { include: [], exclude: [] })
  assert.equal(calls, 4)
  assert.equal(peak, 2)
  controller.invalidate()
  await controller.freeze(draft(3), { include: [], exclude: [] })
  assert.equal(calls, 8)
  controller.invalidate()
})

test('context, catalog, connection, and workspace revisions prevent cache reuse', async () => {
  let calls = 0
  let revision = 'original'; let workspace = 'first'; let model = 'first'
  const { controller } = setup({ catalog: async () => ({ ...catalog, revision }), metadata: () => workspace,
    connection: async () => ({ enabled: true, useMainConnection: true, format: 'typesafe', baseUrl: 'https://example.com', model, threshold: 0.75 }),
    decide: async (_connection, _input, skills) => { calls++; return skills.map((skill) => ({ skillId: skill.name, probability: 0.9 })) } })
  const analyze = async (number: number, recentChat: SkillDraft['recentChat'] = []) => {
    controller.cancel(); await controller.freeze({ ...draft(number), recentChat }, { include: [], exclude: [] })
  }
  await analyze(1)
  await analyze(2)
  assert.equal(calls, 1)
  await analyze(3, [{ role: 'user', text: 'Different conversation' }])
  revision = 'changed'; await analyze(4)
  model = 'changed'; await analyze(5)
  workspace = 'changed'; await analyze(6)
  assert.equal(calls, 5)
  controller.invalidate()
})

test('session changes and cancellation abort requests and do not publish old results', async () => {
  let currentSession = 'session'; let observedSignal: AbortSignal | undefined
  let finish!: (value: Array<{ skillId: string; probability: number }>) => void
  const { controller, updates } = setup({ debounceMs: 0, currentSession: () => currentSession,
    decide: async (_connection, _input, _skills, signal) => { observedSignal = signal; return new Promise((resolve) => { finish = resolve }) } })
  controller.update(draft(1)); await pause(10)
  currentSession = 'new-session'; controller.invalidate()
  assert.equal(observedSignal?.aborted, true)
  const count = updates.length
  finish([{ skillId: 'one', probability: 1 }]); await pause(10)
  assert.equal(updates.length, count)
  controller.update(draft(2))
  assert.equal(updates.length, count, 'Old-session draft messages are ignored')
})

test('late catalog refreshes cannot replace a newer catalog or survive invalidation', async () => {
  const pending: Array<(value: SkillCatalog) => void> = []
  const catalogs: SkillCatalog[] = []
  const { controller } = setup({ catalog: () => new Promise((resolve) => pending.push(resolve)),
    publishCatalog: (_sessionId, value) => catalogs.push(value) })
  const old = controller.loadCatalog('session')
  const current = controller.loadCatalog('session')
  pending[1]!({ ...catalog, revision: 'new' }); await current
  pending[0]!({ ...catalog, revision: 'old' }); await old
  assert.deepEqual(catalogs.map((value) => value.revision), ['new'])
  const invalidated = controller.loadCatalog('session'); controller.invalidate()
  pending[2]!({ ...catalog, revision: 'invalidated' }); await invalidated
  assert.deepEqual(catalogs.map((value) => value.revision), ['new'])
})

test('final routing status preserves API failure details for the drawer', async () => {
  const { controller, updates } = setup({ debounceMs: 0,
    decide: async () => { throw new Error('Decisions endpoint returned HTTP 400. Unknown model: any') } })
  controller.update(draft(1)); await pause(20)
  assert.equal(updates.at(-1)?.status, 'unavailable')
  assert.equal(updates.at(-1)?.message, 'Decisions endpoint returned HTTP 400. Unknown model: any')
  controller.invalidate()
})

test('final routing status preserves discovery failures and invalid-answer details', async () => {
  const failed = setup({ debounceMs: 0, catalog: async () => { throw new Error('Registry unavailable') } })
  failed.controller.update(draft(1)); await pause(20)
  assert.equal(failed.updates.at(-1)?.message, 'Registry unavailable')
  failed.controller.invalidate()
  const invalid = setup({ debounceMs: 0, decide: async () => [{ skillId: 'one' }] })
  invalid.controller.update(draft(1)); await pause(20)
  assert.match(invalid.updates.at(-1)?.message ?? '', /missing, refused, or invalid answers/)
  invalid.controller.invalidate()
})

test('background analysis can finish beyond the send budget and exposes scores and timing', async () => {
  const { controller, updates } = setup({ debounceMs: 0, timeoutMs: 500, sendTimeoutMs: 10,
    decide: async () => { await pause(40); return [{ skillId: 'one', probability: 0 }, { skillId: 'two', probability: 0.74 }] } })
  controller.update(draft(1))
  await pause(80)
  const result = updates.at(-1)!
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.selected, [])
  assert.deepEqual(result.probabilities, { one: 0, two: 0.74 })
  assert.equal(result.threshold, 0.75)
  assert.ok(result.elapsedMs! >= 40)
  assert.deepEqual((await controller.freeze(draft(1), { include: ['two'], exclude: [] })).include, ['two'])
  controller.invalidate()
})

test('diagnostics identify connection, candidates, probabilities, and manual overrides without prompt or key', async () => {
  const events: Parameters<NonNullable<SkillControllerOptions['diagnostic']>>[0][] = []
  const { controller } = setup({ diagnostic: (event) => events.push(event),
    connection: async () => ({ enabled: true, useMainConnection: true, format: 'typesafe',
      baseUrl: 'https://example.com/proxy/v1', apiKey: 'private-secret', model: 'decision-model', threshold: 0.75 }) })
  await controller.freeze(draft(1, 'private draft contents'), { include: ['two'], exclude: ['one'] })
  const started = events.find((event) => event.phase === 'started')!
  assert.equal(started.details.endpoint, 'https://example.com/proxy/v1/systemone')
  assert.equal(started.details.model, 'decision-model')
  assert.equal(started.details.threshold, 0.75)
  assert.deepEqual(started.details.skills, catalog.skills)
  assert.deepEqual(events.find((event) => event.phase === 'answers')?.details.answers,
    [{ skillId: 'one', probability: 0.75 }, { skillId: 'two', probability: 0.74 }])
  assert.deepEqual(events.find((event) => event.phase === 'submitted')?.details,
    { include: ['two'], exclude: ['one'], manual: ['two'] })
  assert.equal(JSON.stringify(events).includes('private-secret'), false)
  assert.equal(JSON.stringify(events).includes('private draft contents'), false)
  controller.invalidate()
})

test('diagnostic failures cannot disrupt skill selection', async () => {
  const { controller } = setup({ diagnostic: () => { throw new Error('Output channel disposed') } })
  assert.deepEqual((await controller.freeze(draft(1), { include: [], exclude: [] })).include, ['one'])
  controller.invalidate()
})
