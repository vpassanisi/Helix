import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CONTROL_CAPABILITIES,
  CONTROL_PROTOCOL_VERSION,
  encodeControlEnvelope,
  parseControlLine,
  type ControlEnvelope,
  type ControlRequestEnvelope,
} from '../runtime/control-protocol.js'
import { ControlTransport } from '../runtime/dsh-control-transport.js'

interface TestServer {
  server: Server
  endpoint: string
  directory: string
  nextSocket: () => Promise<Socket>
  envelopesFrom(socket: Socket): AsyncGenerator<ControlEnvelope>
  close: () => Promise<void>
}

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

async function startServer(): Promise<TestServer> {
  const directory = await mkdtemp(join(tmpdir(), 'helix-transport-test-'))
  const endpoint = join(directory, 'control.sock')
  const server = createServer()
  const sockets: Socket[] = []
  const envelopeReaders = new Map<Socket, AsyncGenerator<ControlEnvelope>>()
  server.on('connection', (socket) => {
    sockets.push(socket)
    // The envelope reader must be attached before the socket starts flowing,
    // or the transport's hello chunk is consumed before the test can read it;
    // the no-op data listener keeps the socket flowing so an unread hello
    // cannot hold the connection open after the client side is destroyed.
    envelopeReaders.set(socket, readEnvelopes(socket))
    socket.on('data', () => undefined)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })

  const nextSocket = async (): Promise<Socket> => {
    const deadline = Date.now() + 3_000
    while (sockets.length === 0) {
      if (Date.now() > deadline) throw new Error('the transport never connected')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return sockets.shift()!
  }

  return {
    server,
    endpoint,
    directory,
    nextSocket,
    envelopesFrom: (socket: Socket) => envelopeReaders.get(socket)!,
    close: async () => {
      for (const socket of sockets.splice(0)) socket.destroy()
      envelopeReaders.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function ackHello(socket: Socket): void {
  socket.write(encodeControlEnvelope({
    version: CONTROL_PROTOCOL_VERSION,
    type: 'helloAck',
    capabilities: CONTROL_CAPABILITIES,
  }))
}

test('handshakes, routes requests to the hook, and sends responses and events', async () => {
  const world = await startServer()
  const requests: ControlRequestEnvelope[] = []
  const transport = new ControlTransport(world.endpoint, 'token-1', {
    onRequest: (request) => requests.push(request),
  })

  try {
    transport.connect()
    const socket = await world.nextSocket()
    const envelopes = world.envelopesFrom(socket)

    const hello = await envelopes.next()
    assert.equal(hello.value?.type, 'hello')
    assert.equal(hello.value?.token, 'token-1')
    assert.equal(transport.isConnected, false, 'not connected before the ack')

    ackHello(socket)
    const connectedDeadline = Date.now() + 2_000
    while (!transport.isConnected && Date.now() < connectedDeadline) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(transport.isConnected, true)

    const request: ControlRequestEnvelope = {
      version: CONTROL_PROTOCOL_VERSION,
      type: 'request',
      requestId: 'req-1',
      method: 'turn.cancel',
      sessionId: 'session-a',
      params: {},
    }
    socket.write(encodeControlEnvelope(request))
    const requestDeadline = Date.now() + 2_000
    while (requests.length === 0 && Date.now() < requestDeadline) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].requestId, 'req-1')
    assert.equal(requests[0].method, 'turn.cancel')

    transport.sendResponse(requests[0], { ok: true })
    const sent = await envelopes.next()
    assert.equal(sent.value?.type, 'response')
    assert.equal(sent.value?.requestId, 'req-1')
    assert.equal(sent.value?.ok, true)
    assert.deepEqual(sent.value?.result, { ok: true })

    assert.equal(transport.sendEvent('session-a', 'assistant.stream', { frame: { type: 'start' } }), true)
    const event = await envelopes.next()
    assert.equal(event.value?.type, 'event')
    assert.equal(event.value?.sessionId, 'session-a')
    assert.equal(event.value?.method, 'assistant.stream')
    assert.deepEqual(event.value?.params, { frame: { type: 'start' } })

    transport.sendResponse(requests[0], undefined, { code: 'SESSION_NOT_FOUND', message: 'no such session' })
    const error = await envelopes.next()
    assert.equal(error.value?.ok, false)
    assert.equal(error.value?.error?.code, 'SESSION_NOT_FOUND')
  } finally {
    transport.dispose()
    await world.close()
  }
})

test('reconnects after the host side drops the socket', async () => {
  const world = await startServer()
  let closeCalled = 0
  let helloSeen = 0
  let activeSocket: Socket | undefined
  world.server.on('connection', (socket) => {
    activeSocket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (!chunk.includes('"type":"hello"')) return
      helloSeen += 1
      ackHello(socket)
    })
  })

  const transport = new ControlTransport(world.endpoint, 'token-2', {
    onRequest: () => undefined,
    onClose: () => closeCalled += 1,
  })

  try {
    transport.connect()
    const helloDeadline = Date.now() + 3_000
    while (helloSeen < 1 && Date.now() < helloDeadline) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(helloSeen, 1)
    assert.equal(transport.isConnected, true)

    activeSocket?.destroy()
    const closeDeadline = Date.now() + 3_000
    while (closeCalled === 0 && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(closeCalled, 1)
    assert.equal(transport.isConnected, false)

    const reconnectDeadline = Date.now() + 3_000
    while (helloSeen < 2 && Date.now() < reconnectDeadline) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(helloSeen, 2, 'the transport reconnects within its first 100ms budget')
    assert.equal(transport.isConnected, true)
  } finally {
    transport.dispose()
    await world.close()
  }
})

test('dispose stops reconnection and send becomes a no-op', async () => {
  const world = await startServer()
  const transport = new ControlTransport(world.endpoint, 'token-3', {
    onRequest: () => undefined,
  })

  try {
    transport.connect()
    await world.nextSocket()
    transport.dispose()
    assert.equal(transport.isConnected, false)
    assert.equal(transport.sendEvent('session-a', 'assistant.stream', {}), false)
    assert.equal(transport.send({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'event',
      eventId: 'e1',
      sessionId: 'session-a',
      method: 'assistant.stream',
      params: {},
    } as ControlEnvelope), false)
  } finally {
    await world.close()
  }
})
