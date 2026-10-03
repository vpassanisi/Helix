import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveToolCallTracker } from '../shared/live-tool-call-tracker.js'

function start(attemptId: string, step = 1): Record<string, unknown> {
  return { type: 'start', attemptId, turn: 1, step }
}

function delta(attemptId: string, index: number, id: string, name?: string): Record<string, unknown> {
  return {
    type: 'chunk',
    attemptId,
    chunk: { type: 'tool-call-delta', index, id, name, argumentsDelta: 'large file contents' },
  }
}

test('reports a large write once and updates its name without retaining arguments', () => {
  const tracker = new LiveToolCallTracker()
  tracker.recordFrame('agent-a', start('attempt-1'))

  assert.deepEqual(tracker.recordFrame('agent-a', delta('attempt-1', 0, 'call-1')), {
    prepared: { callId: 'call-1', name: 'Tool call' }, discard: [],
  })
  assert.deepEqual(tracker.recordFrame('agent-a', delta('attempt-1', 0, 'call-1', 'fs.write')), {
    prepared: { callId: 'call-1', name: 'fs.write' }, discard: [],
  })
  assert.deepEqual(tracker.recordFrame('agent-a', delta('attempt-1', 0, 'call-1', 'fs.write')), {
    discard: [],
  })
  tracker.finishCall('agent-a', 'call-1')
  assert.deepEqual(tracker.clear(), [])
})

test('keeps separate concurrent calls and reconciles only committed IDs', () => {
  const tracker = new LiveToolCallTracker()
  tracker.recordFrame('agent-a', start('attempt-1'))
  tracker.recordFrame('agent-a', delta('attempt-1', 0, 'call-1', 'fs.write'))
  tracker.recordFrame('agent-a', delta('attempt-1', 1, 'call-2', 'terminal'))

  assert.deepEqual(tracker.reconcileMessage('agent-a', {
    turn: 1, step: 1,
    message: { content: [{ type: 'tool-call', id: 'call-1' }] },
  }), ['call-2'])
  assert.deepEqual(tracker.clear('agent-a'), ['call-1'])
})

test('drops incomplete calls on failed attempts, retries, and cancellation', () => {
  const tracker = new LiveToolCallTracker()
  tracker.recordFrame('agent-a', start('attempt-1'))
  tracker.recordFrame('agent-a', delta('attempt-1', 0, 'old-call', 'fs.write'))
  assert.deepEqual(tracker.recordFrame('agent-a', {
    type: 'end', attemptId: 'attempt-1', outcome: { kind: 'committed', eventType: 'assistant/attempt' },
  }).discard, ['old-call'])

  tracker.recordFrame('agent-a', start('attempt-2'))
  tracker.recordFrame('agent-a', delta('attempt-2', 0, 'retry-call', 'fs.write'))
  assert.deepEqual(tracker.recordFrame('agent-a', start('attempt-3')).discard, ['retry-call'])
  tracker.recordFrame('agent-a', delta('attempt-3', 0, 'cancel-call', 'fs.write'))
  assert.deepEqual(tracker.clear('agent-a'), ['cancel-call'])
})

test('cleans up a successful stream whose partial call was not committed', () => {
  const tracker = new LiveToolCallTracker()
  tracker.recordFrame('agent-a', start('attempt-1'))
  tracker.recordFrame('agent-a', delta('attempt-1', 0, 'partial-call', 'fs.write'))
  assert.deepEqual(tracker.recordFrame('agent-a', {
    type: 'end', attemptId: 'attempt-1', outcome: { kind: 'committed', eventType: 'assistant/message' },
  }).discard, [])
  assert.deepEqual(tracker.reconcileMessage('agent-a', {
    turn: 1, step: 1, message: { content: [{ type: 'text', text: 'No tool call' }] },
  }), ['partial-call'])
})

test('isolates agents and clears abandoned attempts', () => {
  const tracker = new LiveToolCallTracker()
  tracker.recordFrame('agent-a', start('attempt-1'))
  tracker.recordFrame('agent-b', start('attempt-1'))
  tracker.recordFrame('agent-a', delta('attempt-1', 0, 'call-a', 'fs.write'))
  tracker.recordFrame('agent-b', delta('attempt-1', 0, 'call-b', 'fs.write'))

  assert.deepEqual(tracker.recordFrame('agent-a', {
    type: 'end', attemptId: 'attempt-1', outcome: { kind: 'abandoned' },
  }).discard, ['call-a'])
  assert.deepEqual(tracker.clear('agent-b'), ['call-b'])
})

test('clears incomplete calls for a failed durable attempt', () => {
  const tracker = new LiveToolCallTracker()
  tracker.recordFrame('agent-a', start('attempt-1'))
  tracker.recordFrame('agent-a', delta('attempt-1', 0, 'partial-call', 'fs.write'))

  assert.deepEqual(tracker.clearStep('agent-a', { turn: 1, step: 1 }), ['partial-call'])
  assert.deepEqual(tracker.clear(), [])
})
