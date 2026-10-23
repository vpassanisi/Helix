import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandController, type CommandControllerOptions } from '../host/command-controller.js'
import type { CommandCatalog } from '../shared/commands.js'

const CATALOG: CommandCatalog = { commands: [{ name: 'compact', description: 'Compact older conversation history' }], available: true }

function controller(session: { id: string }, options: Partial<CommandControllerOptions> = {}) {
  const published: unknown[] = []
  const runs: string[] = []
  let release: (() => void) | undefined
  const instance = new CommandController({
    currentSession: () => session.id,
    catalog: async () => CATALOG,
    run: async (_sessionId, name) => {
      runs.push(name)
      await new Promise<void>((resolve) => { release = resolve })
      return { kind: 'success', text: `/${name} finished.` }
    },
    publishCatalog: (sessionId, catalog, error) => published.push({ type: 'catalog', sessionId, catalog, error }),
    publishResult: (sessionId, name, kind, text) => published.push({ type: 'result', sessionId, name, kind, text }),
    ...options,
  })
  return { instance, published, runs, release: () => release?.() }
}

test('publishes the command catalog for the session the composer is showing', async () => {
  const session = { id: 'session-a' }
  const { instance, published } = controller(session)

  await instance.load(session.id)
  assert.deepEqual(published, [{ type: 'catalog', sessionId: 'session-a', catalog: CATALOG, error: undefined }])

  session.id = 'session-b'
  await instance.load('session-a')
  assert.equal(published.length, 1, 'a catalog for a session the webview left is dropped')
})

test('reports an unavailable command registry instead of failing the composer', async () => {
  const session = { id: 'session-a' }
  const { instance, published } = controller(session, {
    catalog: async () => { throw new Error('The DSH command registry is unavailable.') },
  })

  await instance.load(session.id)
  assert.deepEqual(published[0], {
    type: 'catalog', sessionId: 'session-a', catalog: { commands: [], available: false },
    error: 'The DSH command registry is unavailable.',
  })
})

test('refuses a second command while one is running', async () => {
  const session = { id: 'session-a' }
  const { instance, published, runs, release } = controller(session)

  const first = instance.run(session.id, 'compact', '')
  const second = instance.run(session.id, 'plan', 'off')
  assert.deepEqual(published, [{ type: 'result', sessionId: 'session-a', name: 'plan', kind: 'error', text: 'Another command is still running.' }])
  assert.deepEqual(runs, ['compact'], 'the refused command never reaches the Host')

  release()
  await Promise.all([first, second])
  assert.deepEqual(published.at(-1), { type: 'result', sessionId: 'session-a', name: 'compact', kind: 'success', text: '/compact finished.' })

  const third = instance.run(session.id, 'compact', '')
  assert.deepEqual(runs, ['compact', 'compact'], 'the next command runs once the first settles')
  release()
  await third
})

test('turns a failed command run into its message, not a stack', async () => {
  const session = { id: 'session-a' }
  const published: unknown[] = []
  const instance = new CommandController({
    currentSession: () => session.id,
    catalog: async () => CATALOG,
    run: async () => { throw new Error('The agent is busy; wait for the current turn to finish.') },
    publishCatalog: () => undefined,
    publishResult: (sessionId, name, kind, text) => published.push({ sessionId, name, kind, text }),
  })

  await instance.run(session.id, 'compact', '')
  assert.deepEqual(published, [{
    sessionId: 'session-a', name: 'compact', kind: 'error',
    text: 'The agent is busy; wait for the current turn to finish.',
  }])
})
