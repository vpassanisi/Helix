import assert from 'node:assert/strict'
import test from 'node:test'
import { CompactionHistory, compactionDetail, compactionTitle } from '../shared/compaction-history.js'

test('one history entry survives start, summary, and confirmed completion', () => {
  const history = new CompactionHistory()
  const start = history.record('root', 'compaction/start', { compactionId: 'a', turn: 10 })!
  const summary = history.record('root', 'compaction/summary', {
    compactionId: 'a', shadowedSeqs: [8, 9, 10], shadowedTokenCount: 96890,
  })!
  assert.equal(summary.key, start.key)
  assert.equal(summary.status, 'running', 'summary arrival must not announce completion before commit closes')
  const end = history.record('root', 'compaction/end', { compactionId: 'a', turn: 10 })!
  assert.equal(end.key, start.key)
  assert.equal(end.status, 'completed')
  assert.equal(compactionTitle(end), 'Conversation compacted')
  assert.equal(compactionDetail(end), '3 history entries · 96,890 tokens of earlier context summarized.')
  assert.deepEqual(history.interrupt(), [], 'later idle status leaves the completed marker intact')
})

test('interleaved subagent events and reused operation IDs stay isolated', () => {
  const history = new CompactionHistory()
  const root = history.record('root', 'compaction/start', { compactionId: 'same' })!
  const child = history.record('child', 'compaction/start', { compactionId: 'same' })!
  assert.notEqual(root.key, child.key)
  history.record('child', 'compaction/end', { compactionId: 'same' })
  const interrupted = history.interrupt('root')
  assert.equal(interrupted.length, 1)
  assert.equal(interrupted[0].key, root.key)
  assert.equal(interrupted[0].status, 'interrupted')
  assert.deepEqual(history.interrupt('child'), [])
})

test('failed and cancelled operations keep a terminal history marker', () => {
  const history = new CompactionHistory()
  history.record('root', 'compaction/start', { compactionId: 'failure' })
  const failed = history.record('root', 'compaction/end', { compactionId: 'failure', error: 'Summary request timed out' })!
  assert.equal(failed.status, 'failed')
  assert.equal(compactionDetail(failed), 'Summary request timed out')
  history.record('root', 'compaction/start', { compactionId: 'cancelled' })
  const [cancelled] = history.interrupt()
  assert.equal(cancelled.status, 'interrupted')
  assert.equal(compactionTitle(cancelled), 'Compaction interrupted')
  assert.equal(compactionDetail(cancelled), 'Stopped before completion was confirmed.')
  // A close event can still arrive after the user presses Stop.
  assert.equal(history.record('root', 'compaction/end', { compactionId: 'cancelled', error: 'Aborted' })!.key, cancelled.key)
})

test('runtime failure stops every active indicator without changing prior completions', () => {
  const history = new CompactionHistory()
  history.record('root', 'compaction/end', { compactionId: 'done' })
  history.record('root', 'compaction/start', { compactionId: 'a' })
  history.record('child', 'compaction/start', { compactionId: 'b' })
  const changed = history.interrupt(undefined, 'Runtime disconnected')
  assert.equal(changed.length, 2)
  assert.ok(changed.every((entry) => entry.status === 'failed' && entry.error === 'Runtime disconnected'))
  assert.deepEqual(history.interrupt(), [])
})

test('pruning without a summary creates one visible marker per pass', () => {
  const history = new CompactionHistory()
  const first = history.record('root', 'compaction/prune', { shadowedSeqs: [10] })!
  history.record('root', 'tool/result', {})
  const second = history.record('root', 'compaction/prune', { shadowedSeqs: [20] })!
  assert.equal(second.key, first.key)
  assert.equal(second.status, 'completed')
  assert.equal(compactionTitle(second), 'Tool results trimmed')
  assert.equal(compactionDetail(second), '2 large tool results shortened to free up context.')
  const child = history.record('child', 'compaction/prune', {})!
  assert.notEqual(child.key, first.key)
  history.record('root', 'step/start', { turn: 1, step: 2 })
  const nextPass = history.record('root', 'compaction/prune', {})!
  assert.notEqual(nextPass.key, first.key)
  assert.equal(nextPass.pruneCount, 1)
})

test('transcript reset clears lifecycle state and missing metadata has readable fallback text', () => {
  const history = new CompactionHistory()
  history.record('root', 'compaction/start', { compactionId: 'old' })
  history.reset()
  assert.deepEqual(history.interrupt(), [])
  assert.equal(history.record('root', 'assistant/message', {}), undefined)
  const completed = history.record('root', 'compaction/end', { compactionId: 'new' })!
  assert.equal(compactionDetail(completed), 'Earlier turns summarized; recent context retained.')
})
