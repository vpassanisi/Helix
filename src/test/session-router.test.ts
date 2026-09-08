import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionNotificationRouter } from '../runtime/session-router.js'

function notification(method: string, params: Record<string, unknown>) {
  return { method, params }
}

test('routes exact session events without cross-session delivery', () => {
  const receivedA: string[] = []
  const receivedB: string[] = []
  const router = new SessionNotificationRouter()

  router.register('session-a', ({ notification }) => receivedA.push(notification.method), 'exact')
  router.register('session-b', ({ notification }) => receivedB.push(notification.method), 'exact')

  router.accept(notification('session.event', { sessionId: 'session-a', event: {} }))
  router.accept(notification('session.status', { sessionId: 'session-b', status: 'idle' }))

  assert.deepEqual(receivedA, ['session.event'])
  assert.deepEqual(receivedB, ['session.status'])
})

test('routes descendant activity to a tree root', () => {
  const received: string[] = []
  const router = new SessionNotificationRouter()
  router.register('root', ({ sessionId, notification }) => received.push(`${sessionId}:${notification.method}`), 'tree')

  router.accept(notification('subagent.started', { parentSessionId: 'root', childSessionId: 'child' }))
  router.accept(notification('session.event', { sessionId: 'child', event: {} }))
  router.accept(notification('session.status', { sessionId: 'unrelated', status: 'running' }))
  router.accept(notification('subagent.finished', { parentSessionId: 'root', childSessionId: 'child' }))

  assert.deepEqual(received, [
    'child:subagent.started',
    'child:session.event',
    'child:subagent.finished',
  ])
})

test('does not deliver unknown sessions', () => {
  let delivered = false
  let unrouted = 0
  const router = new SessionNotificationRouter({ onUnrouted: () => { unrouted += 1 } })
  router.register('known', () => { delivered = true })

  router.accept(notification('session.event', { sessionId: 'unknown', event: {} }))

  assert.equal(delivered, false)
  assert.equal(unrouted, 1)
})

test('clears lineage on reset', () => {
  let delivered = 0
  const router = new SessionNotificationRouter()
  router.register('root', () => { delivered += 1 })

  router.accept(notification('subagent.started', { parentSessionId: 'root', childSessionId: 'child' }))
  router.resetLineage()
  router.accept(notification('session.event', { sessionId: 'child', event: {} }))

  assert.equal(delivered, 1)
})
