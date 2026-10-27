import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../runtime/dsh-gen-ui-tool-plugin.js'

const spec = { root: 'a', elements: { a: { type: 'Text', props: { text: 'Two failing tests' }, children: [] } } }

function fixture(config: { enabled?: boolean } = {}) {
  const registered: any[] = []
  const hooks: Array<(carry: any, context: any, next: () => Promise<any>) => Promise<any>> = []
  const root = { id: 'root' }
  const child = { id: 'task-1' }
  const agents = new Map([['root', root], ['task-1', child]])
  const ctx = {
    tools: { register: (tool: any) => { registered.push(tool) } },
    get: (name: string) => (name === 'agents' ? { get: (id: string) => agents.get(id), roots: () => [root] } : undefined),
    on: (_event: string, hook: any) => { hooks.push(hook) },
  }
  apply(ctx, config)
  return { tool: registered[0], hooks, root, child }
}

test('the plugin registers show_ui and one prompt section', () => {
  const { tool, hooks } = fixture()
  assert.equal(tool.name, 'show_ui')
  assert.deepEqual(tool.parameters.required, ['spec'])
  assert.match(tool.parameters.properties.spec.description, /catalog in the system prompt/)
  assert.match(tool.description, /Only the main agent can render/)
  assert.equal(hooks.length, 1)
})

test('a card call answers with a count, not with the spec it just sent', async () => {
  const { tool, root } = fixture()
  const result = await tool.execute({ spec, title: '  Tests  ' }, { agent: root })
  assert.deepEqual(result, { displayed: true, elements: 1, title: 'Tests' })
  const blocks = tool.output.render({}, result)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /1 elements/)
  assert.match(blocks[0].text, /Do not repeat/)
  assert.match(blocks[0].text, /end the turn on it/)
})

test('a spec the catalog refuses is a tool error the model can act on', async () => {
  const { tool, root } = fixture()
  await assert.rejects(() => tool.execute({ spec: { root: 'a', elements: { a: { type: 'Marquee', props: {} } } } }, { agent: root }), /not a Helix component/)
  await assert.rejects(() => tool.execute({ spec: {} }, { agent: root }), /spec/)
  await assert.rejects(() => tool.execute({}, { agent: root }), /spec/)
})

test('a child agent is told to report the card to its parent, not shown a card it cannot place', async () => {
  const { tool, child } = fixture()
  await assert.rejects(() => tool.execute({ spec }, { agent: child }), /main agent/)
  await assert.rejects(() => tool.execute({ spec }, {}), /main agent/)
})

test('the prompt section is added once, whoever assembles the prompt', async () => {
  const { hooks } = fixture()
  const assemble = hooks[0]
  const carry = () => ({ sections: [] as any[], contexts: [], tools: [] })
  const first = await assemble(carry(), {}, async () => carry())
  assert.equal(first.sections.length, 1)
  assert.equal(first.sections[0].name, 'helix:gen-ui')
  assert.match(first.sections[0].text, /show_ui/)
  const second = await assemble(first, {}, async () => first)
  assert.equal(second.sections.length, 1)
  // A plugin that already contributed a section of this name is left alone.
  const taken = { sections: [{ name: 'helix:gen-ui', text: 'other' }], contexts: [], tools: [] }
  assert.equal((await assemble(taken, {}, async () => taken)).sections.length, 1)
})

test('switching the bundle off registers nothing at all', () => {
  const { tool, hooks } = fixture({ enabled: false })
  assert.equal(tool, undefined)
  assert.equal(hooks.length, 0)
})
