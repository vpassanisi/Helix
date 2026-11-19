import assert from 'node:assert/strict'
import test from 'node:test'
import { isToolPresentation, projectToolPresentation, toolPresentationLine } from '../shared/tool-presentation.js'
import { DshToolPresentationBridge } from '../runtime/dsh-tool-presentation-bridge.js'

function bridgeFor(tool: Record<string, unknown> | undefined, available = true) {
  const events: Array<{ sessionId: string; method: string; params: Record<string, unknown> }> = []
  const ctx = { get: (name: string) => (name === 'tools' ? { get: () => tool } : undefined) }
  const bridge = new DshToolPresentationBridge(ctx, () => available,
    (sessionId, method, params) => { events.push({ sessionId, method, params }); return true })
  return { bridge, events }
}

test('projects a read presenter view to the wire shape', () => {
  const view = projectToolPresentation({
    card: 'generic',
    title: 'Read src/webview/App.svelte (30 - 60)',
    kind: 'read',
    locations: [{ path: '/Users/dev/helix/src/webview/App.svelte', line: 30 }],
  })
  assert.deepEqual(view, {
    card: 'generic',
    title: 'Read src/webview/App.svelte (30 - 60)',
    kind: 'read',
    locations: [{ path: '/Users/dev/helix/src/webview/App.svelte', line: 30 }],
  })
})

test('keeps the terminal card fields a card can render', () => {
  const view = projectToolPresentation({ card: 'terminal', title: 'npm test', description: 'Run the suite', cwd: '/Users/dev/helix' })
  assert.deepEqual(view, { card: 'terminal', title: 'npm test', description: 'Run the suite', kind: 'execute', cwd: '/Users/dev/helix' })
})

test('drops an unknown card, a non-object, and a view with nothing to show', () => {
  assert.equal(projectToolPresentation({ card: 'nonsense', title: 'x' }), undefined)
  assert.equal(projectToolPresentation('Read x'), undefined)
  assert.equal(projectToolPresentation(undefined), undefined)
  assert.equal(projectToolPresentation({ card: 'generic', title: '   ' }), undefined)
})

test('drops fields of the wrong type and an unknown category', () => {
  const view = projectToolPresentation({ card: 'diff', title: 'Write a.ts', kind: 'teleport', locations: [{ path: 1 }, { line: 2 }] })
  assert.deepEqual(view, { card: 'diff', title: 'Write a.ts', kind: 'edit' })
})

test('a card shape implies an icon when the presenter leaves the category out', () => {
  assert.equal(projectToolPresentation({ card: 'diff', title: 'Write a.ts' })?.kind, 'edit')
  assert.equal(projectToolPresentation({ card: 'search', title: 'Glob' })?.kind, 'search')
  assert.equal(projectToolPresentation({ card: 'read', title: 'Read a.ts' })?.kind, 'read')
  assert.equal(projectToolPresentation({ card: 'generic', title: 'Read a.ts' })?.kind, undefined)
  // A presenter that names its own category is not second-guessed.
  assert.equal(projectToolPresentation({ card: 'diff', title: 'Move a.ts', kind: 'move' })?.kind, 'move')
})

test('clips a runaway label and caps the locations', () => {
  const view = projectToolPresentation({
    card: 'generic',
    title: 'q'.repeat(500),
    locations: Array.from({ length: 20 }, (_, index) => ({ path: `/w/f${index}.ts`, line: index + 1 })),
  })
  assert.ok(view)
  const title = view.title
  if (typeof title !== 'string') assert.fail('the projector keeps the title as text')
  assert.equal(title.length, 241)
  assert.ok(title.endsWith('…'))
  assert.equal(view.locations?.length, 4)
})

test('a non-integer line is dropped and a zero line is dropped', () => {
  const view = projectToolPresentation({ card: 'generic', title: 'Read a.ts', locations: [{ path: '/a.ts', line: 1.5 }, { path: '/b.ts', line: 0 }] })
  assert.deepEqual(view?.locations, [{ path: '/a.ts' }, { path: '/b.ts' }])
})

test('the wire validator accepts a projected view and rejects a tampered one', () => {
  const view = projectToolPresentation({ card: 'generic', title: 'Read a.ts', kind: 'read', locations: [{ path: '/a.ts', line: 3 }] })
  assert.ok(view)
  assert.equal(isToolPresentation(view), true)
  assert.equal(isToolPresentation({ ...view, card: 'mystery' }), false)
  assert.equal(isToolPresentation({ ...view, title: 7 }), false)
  assert.equal(isToolPresentation({ ...view, kind: 'teleport' }), false)
  assert.equal(isToolPresentation({ ...view, locations: [{ path: 1 }] }), false)
  assert.equal(isToolPresentation('Read a.ts'), false)
})

test('the card line prefers the summary over the title, and nothing over an absent view', () => {
  assert.equal(toolPresentationLine({ card: 'terminal', title: 'npm test', description: 'Run the suite' }), 'Run the suite')
  assert.equal(toolPresentationLine({ card: 'generic', title: 'Read a.ts' }), 'Read a.ts')
  assert.equal(toolPresentationLine(undefined), undefined)
})

test('the bridge publishes one event per call, keyed by the call the registry is running', async () => {
  const { bridge, events } = bridgeFor({ presentCall: () => ({ card: 'generic', title: 'Read a.ts', kind: 'read' }) })
  const result = await bridge.execute({ callId: 'call-1', name: 'read', agent: { id: 'session-1' }, arguments: { file_path: 'a.ts' } }, async () => 'ran')
  assert.equal(result, 'ran')
  assert.equal(events.length, 1)
  assert.equal(events[0].sessionId, 'session-1')
  assert.equal(events[0].method, 'tool.presentation')
  assert.deepEqual(events[0].params, { callId: 'call-1', name: 'read', view: { card: 'generic', title: 'Read a.ts', kind: 'read' } })
})

test('the bridge passes the call through untouched when nothing is worth publishing', async () => {
  const withoutPresenter = bridgeFor({})
  const broken = bridgeFor({ presentCall: () => { throw new Error('tool defect') } })
  const unprojectable = bridgeFor({ presentCall: () => ({ card: 'mystery', title: 'x' }) })
  for (const pair of [withoutPresenter, broken, unprojectable]) {
    assert.equal(await pair.bridge.execute({ callId: 'c', name: 'read', agent: { id: 's' }, arguments: {} }, async () => 'ran'), 'ran')
    assert.equal(pair.events.length, 0)
  }
})

test('the bridge stays quiet with no channel, and for a call with no session', async () => {
  const offline = bridgeFor({ presentCall: () => ({ card: 'generic', title: 'Read a.ts' }) }, false)
  assert.equal(await offline.bridge.execute({ callId: 'c', name: 'read', agent: { id: 's' }, arguments: {} }, async () => 'ran'), 'ran')
  assert.equal(offline.events.length, 0)

  const { bridge, events } = bridgeFor({ presentCall: () => ({ card: 'generic', title: 'Read a.ts' }) })
  assert.equal(await bridge.execute({ callId: 'c', name: 'read', arguments: {} }, async () => 'ran'), 'ran')
  assert.equal(events.length, 0)
})

test('the bridge survives a context with no tools service', async () => {
  const events: unknown[] = []
  const bridge = new DshToolPresentationBridge({}, () => true, () => { events.push(1); return true })
  assert.equal(await bridge.execute({ callId: 'c', name: 'read', agent: { id: 's' }, arguments: {} }, async () => 'ran'), 'ran')
  assert.equal(events.length, 0)
})
