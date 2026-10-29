import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../runtime/dsh-report-progress-plugin.js'
import { REPORT_PROGRESS_LIMIT, REPORT_PROGRESS_TOOL_NAME, parseReportProgressCall } from '../shared/report-progress.js'
import { REPORT_PROGRESS_TOOL_BUNDLE_ID, TOOL_BUNDLE_OPTIONS, toolBundlePatchLines } from '../shared/tool-bundles.js'

function fixture(config: { enabled?: boolean } = {}) {
  const registered: any[] = []
  const root = { id: 'root' }
  const child = { id: 'task-1' }
  const agents = new Map([['root', root], ['task-1', child]])
  const ctx = {
    tools: { register: (tool: any) => { registered.push(tool) } },
    get: (name: string) => (name === 'agents' ? { get: (id: string) => agents.get(id), roots: () => [root] } : undefined),
  }
  apply(ctx, config)
  return { tools: registered, tool: registered[0], root, child }
}

test('a switch off in the Tools page takes the tool out of the runtime', () => {
  assert.deepEqual(fixture({ enabled: false }).tools, [])
  assert.equal(fixture({ enabled: true }).tools.length, 1)
})

test('the note tool is a Tools page toggle and is not a config patch line', () => {
  const bundle = TOOL_BUNDLE_OPTIONS.find((option) => option.id === REPORT_PROGRESS_TOOL_BUNDLE_ID)
  assert.equal(bundle?.tools.join(','), REPORT_PROGRESS_TOOL_NAME)
  assert.equal(toolBundlePatchLines([]).some((line) => line.includes(REPORT_PROGRESS_TOOL_BUNDLE_ID)), false)
  assert.equal(toolBundlePatchLines([REPORT_PROGRESS_TOOL_BUNDLE_ID]).some((line) => line.includes(REPORT_PROGRESS_TOOL_BUNDLE_ID)), false)
})

test('the plugin registers report_progress with one required message', () => {
  const { tool } = fixture()
  assert.equal(tool.name, 'report_progress')
  assert.equal(
    tool.description,
    'Send a brief progress update to the user while continuing work. Use after several tool calls or significant milestones.',
  )
  assert.deepEqual(tool.parameters.required, ['message'])
  assert.match(tool.parameters.properties.message.description, /under 600 characters/)
})

test('a note answers with an acknowledgment, not with the sentence it just sent', async () => {
  const { tool, root } = fixture()
  const result = await tool.execute({ message: '  Reading the runtime wiring.  ' }, { agent: root })
  assert.deepEqual(result, { shown: true, characters: 'Reading the runtime wiring.'.length })
  assert.match(tool.output.render({}, result)[0].text, /shown to the user/)
})

test('a child agent is told to report to its parent instead', async () => {
  const { tool, child } = fixture()
  await assert.rejects(() => tool.execute({ message: 'Almost done.' }, { agent: child }), /parent agent/)
})

test('an empty or oversized note is rejected with what to do instead', async () => {
  const { tool, root } = fixture()
  await assert.rejects(() => tool.execute({ message: '   ' }, { agent: root }), /non-empty "message"/)
  await assert.rejects(() => tool.execute({ message: 'x'.repeat(REPORT_PROGRESS_LIMIT + 1) }, { agent: root }), /under 600 characters/)
})

test('the reader takes the note from an object or from the streamed JSON string', () => {
  assert.deepEqual(parseReportProgressCall({ message: ' Two files left. ' }), { ok: true, text: 'Two files left.' })
  assert.deepEqual(parseReportProgressCall('{"message":"Two files left."}'), { ok: true, text: 'Two files left.' })
  assert.equal(parseReportProgressCall(undefined).ok, false)
  assert.equal(parseReportProgressCall({ message: 3 }).ok, false)
})
