import { once } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTROL_PROTOCOL_VERSION,
  encodeControlEnvelope,
  parseControlLine,
  type ControlEnvelope,
} from '../runtime/control-protocol.js'
import { LocalControlBridge } from '../runtime/control-bridge.js'

function readEnvelopes(socket: Socket): AsyncGenerator<ControlEnvelope> {
  let buffer = ''
  const queue: ControlEnvelope[] = []
  const waiters: Array<(value: IteratorResult<ControlEnvelope>) => void> = []
  let ended = false

  const push = (envelope: ControlEnvelope) => {
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter({ done: false, value: envelope })
    else queue.push(envelope)
  }

  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      const envelope = parseControlLine(line)
      if (envelope !== undefined) push(envelope)
      newlineIndex = buffer.indexOf('\n')
    }
  })
  socket.on('close', () => {
    ended = true
    for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined })
  })

  return {
    next: async () => {
      const value = queue.shift()
      if (value !== undefined) return { done: false, value }
      if (ended) return { done: true, value: undefined }
      return new Promise<IteratorResult<ControlEnvelope>>((resolve) => waiters.push(resolve))
    },
    return: async () => ({ done: true, value: undefined }),
    throw: async (error: unknown) => { throw error },
    [Symbol.asyncIterator]() { return this },
  }
}

test('authenticates the DSH connection and correlates requests', async () => {
  const bridge = new LocalControlBridge()
  await bridge.start()
  assert.ok(bridge.endpoint)
  assert.ok(bridge.token)

  const socket = createConnection(bridge.endpoint)
  const envelopes = readEnvelopes(socket)
  socket.write(encodeControlEnvelope({
    version: CONTROL_PROTOCOL_VERSION,
    type: 'hello',
    token: bridge.token,
  }))

  const helloAck = await envelopes.next()
  assert.equal(helloAck.value?.type, 'helloAck')
  assert.equal(await bridge.waitForConnection(), true)
  assert.ok(bridge.capabilities.includes('turn.cancel'))

  const requestPromise = bridge.cancel('session-a')
  const request = await envelopes.next()
  assert.equal(request.value?.type, 'request')
  assert.equal(request.value?.method, 'turn.cancel')
  assert.equal(request.value?.sessionId, 'session-a')

  socket.write(encodeControlEnvelope({
    version: CONTROL_PROTOCOL_VERSION,
    type: 'response',
    requestId: request.value?.type === 'request' ? request.value.requestId : '',
    ok: true,
    result: { accepted: true },
  }))
  await requestPromise

  await bridge.close()
  socket.destroy()
})

test('rejects an unauthenticated connection without preventing a valid one', async () => {
  const bridge = new LocalControlBridge()
  await bridge.start()
  const endpoint = bridge.endpoint
  const token = bridge.token
  assert.ok(endpoint)
  assert.ok(token)

  const rejected = createConnection(endpoint)
  rejected.write(encodeControlEnvelope({
    version: CONTROL_PROTOCOL_VERSION,
    type: 'hello',
    token: 'wrong-token',
  }))
  await once(rejected, 'close')
  assert.equal(bridge.connected, false)

  const accepted = createConnection(endpoint)
  const envelopes = readEnvelopes(accepted)
  accepted.write(encodeControlEnvelope({
    version: CONTROL_PROTOCOL_VERSION,
    type: 'hello',
    token,
  }))
  assert.equal((await envelopes.next()).value?.type, 'helloAck')
  assert.equal(await bridge.waitForConnection(), true)

  await bridge.close()
  accepted.destroy()
})

test('times out and cleans up a pending request when the peer disconnects', async () => {
  const bridge = new LocalControlBridge()
  await bridge.start()
  const endpoint = bridge.endpoint
  const token = bridge.token
  assert.ok(endpoint)
  assert.ok(token)

  const socket = createConnection(endpoint)
  const envelopes = readEnvelopes(socket)
  socket.write(encodeControlEnvelope({
    version: CONTROL_PROTOCOL_VERSION,
    type: 'hello',
    token,
  }))
  await envelopes.next()
  await bridge.waitForConnection()

  const timeoutRequest = bridge.request('turn.cancel', 'session-a', {}, 10)
  await envelopes.next()
  await assert.rejects(timeoutRequest, (error: { code?: string }) => error.code === 'BRIDGE_TIMEOUT')

  const disconnectRequest = bridge.request('turn.cancel', 'session-a')
  await envelopes.next()
  socket.destroy()
  await assert.rejects(disconnectRequest, (error: { code?: string }) => error.code === 'BRIDGE_CLOSED')

  await bridge.close()
})
