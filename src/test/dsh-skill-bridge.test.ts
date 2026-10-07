import assert from 'node:assert/strict'
import test from 'node:test'
import { DshSkillBridge } from '../runtime/dsh-skill-bridge.js'
import { renderContextSections } from '@deepseek-ai/dsh-system-prompt'

function fixture() {
  const definitions = new Map(['one', 'two', 'three', 'manual-only', 'model-only'].map((name) => [name,
    { name, description: `Description ${name}`, content: `Instructions ${name}: literal {{template}}`, provider: 'test', source: 'runtime',
      resourceBase: { kind: 'directory' as const, path: '/workspace/skills' },
      invocation: { modelInvocable: name !== 'manual-only', userInvocable: name !== 'model-only' } }]))
  const agents = new Map<string, any>()
  let originalCalls = 0
  const original = { name: 'skill', execute: async ({ name }: any) => {
    originalCalls++
    await new Promise((resolve) => setTimeout(resolve, 1))
    const skill = definitions.get(name)
    if (!skill?.invocation.modelInvocable) throw new Error('not model-invocable')
    return { name, provider: 'test', content: skill.content }
  } }
  const ctx = { skills: { get: async (name: string) => definitions.get(name), snapshot: async () => ({ skills: [...definitions.values()], complete: true }) },
    agents: { get: (id: string) => agents.get(id) } }
  function addAgent(id = 'root') {
    let tool: any = original
    const agent = { id, session: { header: { cwd: '/workspace' } }, ctx: { tools: {
      get: () => tool, register: (next: any) => { tool = next; return () => { tool = original } },
    } } }
    agents.set(id, agent)
    return { agent, tool: () => tool }
  }
  const bridge = new DshSkillBridge(ctx, '/workspace')
  async function assemble(agent: any) {
    const initial = { sections: [], contexts: [], tools: [], variables: {} }
    const result = await bridge.assemble(initial, { agent, scope: agent }, async () => initial)
    return renderContextSections(result).map((section) => section.text).join('\n')
  }
  return { bridge, addAgent, assemble, definitions, originalCalls: () => originalCalls }
}

test('staging before agent creation provides canonical instructions on the first assembly', async () => {
  const { bridge, addAgent, assemble, originalCalls } = fixture()
  await bridge.stage('root', { include: ['one'], exclude: ['three'], prompt: '/one /two' })
  const { agent, tool } = addAgent()
  bridge.created({ agent })
  const text = await assemble(agent)
  assert.match(text, /<skill_content name="one">/)
  assert.match(text, /<skill_content name="two">/)
  assert.match(text, /literal \{\{template\}\}/, 'skill template text is not interpolated')
  assert.match(text, /Base directory for this skill: \/workspace\/skills/)
  assert.doesNotMatch(text, /Instructions three/)
  assert.match(text, /Excluded this turn: three/)
  const result = await tool().execute({ name: 'one' }, { agent, signal: new AbortController().signal })
  assert.match(result.content, /already provided/)
  assert.equal(originalCalls(), 0)
  await assert.rejects(tool().execute({ name: 'three' }, { agent }), /excluded/)
  const decision = await bridge.preStep({ agent }, async () => ({ kind: 'enter', messages: [
    { source: { kind: 'skill-invocation', name: 'one' } }, { source: { kind: 'skill-catalog' } }, { source: { kind: 'user' } },
  ] }))
  assert.deepEqual(decision.messages, [{ source: { kind: 'user' } }])
  bridge.dispose()
})

test('remaining skills load once even under concurrent calls, then appear in the active snapshot', async () => {
  const { bridge, addAgent, assemble, originalCalls } = fixture()
  const { agent, tool } = addAgent()
  await bridge.stage('root', { include: ['one'], exclude: [], prompt: 'work' })
  const results = await Promise.all([tool().execute({ name: 'two' }, { agent }), tool().execute({ name: 'two' }, { agent })])
  assert.equal(originalCalls(), 1)
  assert.equal(results.filter((result) => result.content.includes('Instructions two')).length, 1)
  const text = await assemble(agent)
  assert.match(text, /Instructions two/)
  // An active skill loaded before first assembly must not be discarded by preparation.
  assert.equal((text.match(/<skill_content name="two">/g) ?? []).length, 1)
  bridge.dispose()
})

test('turn replacement retires prior skills, refreshes after compaction, and isolates other sessions', async () => {
  const { bridge, addAgent, assemble } = fixture()
  const { agent } = addAgent()
  const { agent: child } = addAgent('child')
  await bridge.stage('root', { include: ['one'], exclude: [], prompt: '' })
  assert.match(await assemble(agent), /Instructions one/)
  assert.match(await assemble(agent), /Instructions one/, 'instructions survive reassembly after compaction')
  assert.equal(await assemble(child), '')
  await bridge.stage('root', { include: ['two'], exclude: ['one'], prompt: '' })
  const text = await assemble(agent)
  assert.doesNotMatch(text, /Instructions one/)
  assert.match(text, /Instructions two/)
  bridge.clear('root')
  assert.equal(await assemble(agent), '')
  bridge.dispose()
})

test('invocation policies distinguish manual selection from automatic selection', async () => {
  const { bridge, addAgent, assemble } = fixture()
  const { agent } = addAgent()
  await assert.rejects(bridge.stage('root', { include: ['manual-only'], exclude: [], prompt: '' }), /invocation/)
  await assert.rejects(bridge.stage('root', { include: ['model-only'], manual: ['model-only'], exclude: [], prompt: '' }), /invocation/)
  await bridge.stage('root', { include: ['manual-only'], manual: ['manual-only'], exclude: [], prompt: '' })
  assert.match(await assemble(agent), /Instructions manual-only/)
  bridge.dispose()
})

test('unstaged and cleared turns retain stock skill loading and explicit invocation messages', async () => {
  const { bridge, addAgent, assemble, originalCalls } = fixture()
  const { agent, tool } = addAgent()
  bridge.created({ agent })
  assert.equal(await assemble(agent), '')
  assert.match((await tool().execute({ name: 'one' }, { agent })).content, /Instructions one/)
  await bridge.stage('root', { include: ['one'], exclude: ['three'], prompt: '' })
  bridge.clear('root')
  assert.equal(await assemble(agent), '')
  assert.match((await tool().execute({ name: 'one' }, { agent })).content, /Instructions one/)
  assert.match((await tool().execute({ name: 'three' }, { agent })).content, /Instructions three/)
  assert.equal(originalCalls(), 3)
  const decision = { kind: 'enter', messages: [{ source: { kind: 'skill-catalog' } }, { source: { kind: 'skill-invocation', name: 'one' } }] }
  assert.equal(await bridge.preStep({ agent }, async () => decision), decision)
  bridge.dispose()
})

test('cancelled staging cannot reappear when a provider finishes late', async () => {
  let finish!: (value: unknown) => void
  const ctx = { skills: { get: () => new Promise((resolve) => { finish = resolve }), snapshot: async () => ({ complete: true, skills: [] }) } }
  const bridge = new DshSkillBridge(ctx, '/workspace')
  const staging = bridge.stage('root', { include: ['one'], exclude: [], prompt: '' })
  bridge.clear('root')
  finish({ name: 'one', content: 'old', invocation: { modelInvocable: true, userInvocable: true } })
  await assert.rejects(staging, /cancelled/)
  bridge.dispose()
})
