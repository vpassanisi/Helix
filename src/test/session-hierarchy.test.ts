import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionHierarchy } from '../runtime/session-hierarchy.js'

test('isolates interleaved root and child session trees', () => {
  const hierarchy = new SessionHierarchy()
  hierarchy.track('subagent.started', { parentSessionId: 'root-a', childSessionId: 'child-a' })
  hierarchy.track('subagent.started', { parentSessionId: 'root-b', childSessionId: 'child-b' })
  hierarchy.track('subagent.started', { parentSessionId: 'child-a', childSessionId: 'grandchild-a' })

  assert.equal(hierarchy.owns('root-a', 'root-a'), true)
  assert.equal(hierarchy.owns('root-a', 'child-a'), true)
  assert.equal(hierarchy.owns('root-a', 'grandchild-a'), true)
  assert.equal(hierarchy.owns('root-a', 'child-b'), false)
  assert.equal(hierarchy.owns('root-b', 'child-a'), false)
})

test('removes finished children and clears session state', () => {
  const hierarchy = new SessionHierarchy()
  hierarchy.track('subagent.started', { parentSessionId: 'root', childSessionId: 'child' })
  hierarchy.track('subagent.finished', { parentSessionId: 'root', childSessionId: 'child' })
  assert.equal(hierarchy.owns('root', 'child'), false)

  hierarchy.track('subagent.started', { parentSessionId: 'root', childSessionId: 'child' })
  hierarchy.clear()
  assert.equal(hierarchy.owns('root', 'child'), false)
})
