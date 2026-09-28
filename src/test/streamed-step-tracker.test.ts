import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamedStepTracker } from '../shared/streamed-step-tracker.js'

test('correlates DSH start and chunk frames with the final assistant message', () => {
  const tracker = new StreamedStepTracker()
  const attemptId = 'session-a:1'

  tracker.recordLiveFrame('session-a', {
    type: 'start',
    attemptId,
    revision: 1,
    turn: 4,
    step: 2,
  })
  tracker.recordLiveFrame('session-a', {
    type: 'chunk',
    attemptId,
    revision: 2,
    index: 0,
    time: 123,
    chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' },
  })

  assert.equal(tracker.hasStreamedStep('session-a', { turn: 4, step: 2 }), true)
})

test('keeps the final-message fallback when no live start frame arrived', () => {
  const tracker = new StreamedStepTracker()

  assert.equal(tracker.hasStreamedStep('session-a', { turn: 4, step: 2 }), false)
})

test('isolates streamed steps by session, turn, and step', () => {
  const tracker = new StreamedStepTracker()
  tracker.recordLiveFrame('session-a', {
    type: 'start',
    attemptId: 'session-a:1',
    revision: 1,
    turn: 4,
    step: 2,
  })

  assert.equal(tracker.hasStreamedStep('session-a', { turn: 4, step: 2 }), true)
  assert.equal(tracker.hasStreamedStep('session-b', { turn: 4, step: 2 }), false)
  assert.equal(tracker.hasStreamedStep('session-a', { turn: 4, step: 3 }), false)
  assert.equal(tracker.hasStreamedStep('session-a', { turn: 5, step: 2 }), false)
})

test('retains legacy assistant/chunk correlation and resets with the transcript', () => {
  const tracker = new StreamedStepTracker()
  tracker.recordDurableChunk('session-a', { turn: 4, step: 2 })

  assert.equal(tracker.hasStreamedStep('session-a', { turn: 4, step: 2 }), true)
  tracker.reset()
  assert.equal(tracker.hasStreamedStep('session-a', { turn: 4, step: 2 }), false)
})
