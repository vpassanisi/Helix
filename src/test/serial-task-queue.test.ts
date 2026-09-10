import assert from 'node:assert/strict'
import test from 'node:test'
import { SerialTaskQueue } from '../runtime/serial-task-queue.js'

test('serializes overlapping operations without running them concurrently', async () => {
  const queue = new SerialTaskQueue()
  const order: string[] = []
  let active = 0
  let maximumActive = 0
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })

  const first = queue.run(async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    order.push('first:start')
    await firstGate
    order.push('first:end')
    active -= 1
    return 'first result'
  })

  await Promise.resolve()
  const second = queue.run(async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    order.push('second:start')
    active -= 1
    return 'second result'
  })

  await Promise.resolve()
  assert.deepEqual(order, ['first:start'])
  assert.equal(maximumActive, 1)

  releaseFirst()
  assert.equal(await first, 'first result')
  assert.equal(await second, 'second result')
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start'])
  assert.equal(maximumActive, 1)
})

test('continues processing after a queued operation rejects', async () => {
  const queue = new SerialTaskQueue()
  const failure = new Error('expected failure')

  await assert.rejects(queue.run(async () => {
    throw failure
  }), failure)

  assert.equal(await queue.run(async () => 'after failure'), 'after failure')
})
