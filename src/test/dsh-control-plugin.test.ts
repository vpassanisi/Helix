import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import test from 'node:test'
import helixControlPlugin from '../runtime/dsh-control-plugin.js'
import { LocalControlBridge } from '../runtime/control-bridge.js'
import {
  CONTROL_CAPABILITIES,
  CONTROL_PROTOCOL_VERSION,
  encodeControlEnvelope,
  parseControlLine,
} from '../runtime/control-protocol.js'

test('adapts control requests and approval decisions to DSH agent services', async () => {
  const sessionAppends: unknown[][] = []
  const cancelCalls: unknown[][] = []
  const steerCalls: unknown[] = []
  const injectCalls: unknown[] = []
  const policyCalls: unknown[][] = []
  type FakeAgent = {
    id: string
    status: 'idle' | 'running'
    session: { header: { parentSession?: string }; append: (...args: unknown[]) => void }
    cancel: (...args: unknown[]) => void
    steer: (message: unknown) => void
    inject: (message: unknown) => void
  }
  const rootAgent: FakeAgent = {
    id: 'root-session',
    status: 'running',
    session: { header: { parentSession: undefined }, append: (...args: unknown[]) => sessionAppends.push(args) },
    cancel: (...args: unknown[]) => cancelCalls.push(args),
    steer: (message: unknown) => steerCalls.push(message),
    inject: (message: unknown) => injectCalls.push(message),
  }
  const childAgent: FakeAgent = {
    id: 'child-session',
    status: 'idle',
    session: { header: { parentSession: 'root-session' }, append: (...args: unknown[]) => sessionAppends.push(args) },
    cancel: (...args: unknown[]) => cancelCalls.push(args),
    steer: (message: unknown) => steerCalls.push(message),
    inject: (message: unknown) => injectCalls.push(message),
  }
  const agents = new Map<string, FakeAgent>([
    [rootAgent.id, rootAgent],
    [childAgent.id, childAgent],
  ])
  let approvalHandler: ((request: any, next: () => Promise<string>) => Promise<string>) | undefined
  let assistantStreamHandler: ((payload: any) => void) | undefined
  let disposePlugin: (() => void) | undefined
  const approvalService = { setPolicy: (agent: unknown, policy: unknown) => policyCalls.push([agent, policy]) }

  const bridge = new LocalControlBridge()
  await bridge.start()
  const endpoint = bridge.endpoint
  const token = bridge.token
  assert.ok(endpoint)
  assert.ok(token)

  const originalEndpoint = process.env.HELIX_CONTROL_ENDPOINT
  const originalToken = process.env.HELIX_CONTROL_TOKEN
  process.env.HELIX_CONTROL_ENDPOINT = endpoint
  process.env.HELIX_CONTROL_TOKEN = token

  try {
    helixControlPlugin({
      get: (name: string) => name === 'agents'
        ? { get: (id: string) => agents.get(id) }
        : name === 'approval' ? approvalService : undefined,
      on: (name: string, handler: typeof approvalHandler) => {
        if (name === 'approval/request') approvalHandler = handler
        if (name === 'agent/assistant-stream') assistantStreamHandler = handler as unknown as (payload: any) => void
      },
      effect: (factory: () => () => void) => { disposePlugin = factory() },
    })
    assert.equal(await bridge.waitForConnection(), true)

    await bridge.cancel('root-session')
    assert.equal(cancelCalls.length, 1)
    assert.deepEqual(cancelCalls[0], [{ kind: 'user' }, { keepInbox: false }])
    await assert.rejects(
      bridge.cancel('missing-session'),
      (error: { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    )

    await bridge.steer('child-session', 'continue', 'root-session')
    await bridge.inject('child-session', 'use the selected file', 'root-session')
    await bridge.setApprovalPolicy('root-session', 'never')
    await bridge.setSandboxMode('child-session', 'workspace-write', 'root-session')
    assert.equal(steerCalls.length, 1)
    assert.equal(injectCalls.length, 1)
    assert.deepEqual(policyCalls, [[rootAgent, 'never']])
    assert.deepEqual(sessionAppends, [['sandbox/mode', { mode: 'workspace-write' }]])
    await assert.rejects(
      bridge.steer('child-session', 'blocked', 'unrelated-session'),
      /not owned/,
    )

    assert.ok(assistantStreamHandler)
    const streamEvent = new Promise<unknown>((resolve) => {
      let disposable: { dispose(): void } | undefined
      disposable = bridge.onEvent((event) => {
        if (event.method !== 'assistant.stream') return
        disposable?.dispose()
        resolve(event)
      })
    })
    assistantStreamHandler?.({
      agent: rootAgent,
      frame: {
        type: 'chunk',
        turn: 1,
        step: 2,
        chunk: { type: 'reasoning-delta', index: 0, text: 'thinking now' },
      },
    })
    const stream = await streamEvent as {
      eventId: string
      sessionId: string
      method: string
      params: Record<string, unknown>
    }
    assert.equal(typeof stream.eventId, 'string')
    assert.equal(stream.sessionId, 'root-session')
    assert.equal(stream.method, 'assistant.stream')
    assert.deepEqual(stream.params, {
      frame: {
        type: 'chunk',
        turn: 1,
        step: 2,
        chunk: { type: 'reasoning-delta', index: 0, text: 'thinking now' },
      },
    })

    assert.ok(approvalHandler)
    let toolExecuted = false
    let approvalRequestResolve: ((requestId: string) => void) | undefined
    const approvalEvent = new Promise<string>((resolve) => { approvalRequestResolve = resolve })
    const eventDisposable = bridge.onEvent((event) => {
      if (event.method === 'approval.request') approvalRequestResolve?.(String(event.params.approvalId))
    })
    const approvalPromise = approvalHandler({
      agent: rootAgent,
      toolName: 'fs.write',
      callId: 'call-1',
      reason: 'write a file',
      signal: new AbortController().signal,
    }, async () => 'unavailable')
    assert.equal(toolExecuted, false)
    const approvalId = await approvalEvent
    await bridge.resolveApproval('root-session', approvalId, 'allowed-once')
    eventDisposable.dispose()
    assert.equal(await approvalPromise, 'allowed-once')
    await assert.rejects(
      bridge.resolveApproval('root-session', approvalId, 'allowed-once'),
      (error: { code?: string }) => error.code === 'APPROVAL_NOT_PENDING',
    )
    toolExecuted = true
    assert.equal(toolExecuted, true)
  } finally {
    disposePlugin?.()
    if (originalEndpoint === undefined) delete process.env.HELIX_CONTROL_ENDPOINT
    else process.env.HELIX_CONTROL_ENDPOINT = originalEndpoint
    if (originalToken === undefined) delete process.env.HELIX_CONTROL_TOKEN
    else process.env.HELIX_CONTROL_TOKEN = originalToken
    await bridge.close()
  }
})

test('does not fail when DSH has already disposed the bridge context', () => {
  const originalEndpoint = process.env.HELIX_CONTROL_ENDPOINT
  const originalToken = process.env.HELIX_CONTROL_TOKEN
  process.env.HELIX_CONTROL_ENDPOINT = '/tmp/helix-control-inactive-test.sock'
  process.env.HELIX_CONTROL_TOKEN = 'test-token'

  try {
    assert.doesNotThrow(() => helixControlPlugin({
      on: () => {
        throw new Error('cannot create effect on inactive context')
      },
    }))
  } finally {
    if (originalEndpoint === undefined) delete process.env.HELIX_CONTROL_ENDPOINT
    else process.env.HELIX_CONTROL_ENDPOINT = originalEndpoint
    if (originalToken === undefined) delete process.env.HELIX_CONTROL_TOKEN
    else process.env.HELIX_CONTROL_TOKEN = originalToken
  }
})

test('retries the plugin connection after a transient startup race', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-plugin-test-'))
  const endpoint = join(directory, 'control.sock')
  const token = 'retry-token'
  const originalEndpoint = process.env.HELIX_CONTROL_ENDPOINT
  const originalToken = process.env.HELIX_CONTROL_TOKEN
  let disposePlugin: (() => void) | undefined
  let helloResolve: (() => void) | undefined
  const hello = new Promise<void>((resolve) => { helloResolve = resolve })
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      const envelope = parseControlLine(chunk.trim())
      if (envelope?.type !== 'hello') return
      helloResolve?.()
      socket.write(encodeControlEnvelope({
        version: CONTROL_PROTOCOL_VERSION,
        type: 'helloAck',
        capabilities: CONTROL_CAPABILITIES,
      }))
    })
  })

  process.env.HELIX_CONTROL_ENDPOINT = endpoint
  process.env.HELIX_CONTROL_TOKEN = token
  try {
    helixControlPlugin({
      on: () => undefined,
      effect: (factory: () => () => void) => { disposePlugin = factory() },
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
    await Promise.race([
      hello,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('plugin did not reconnect')), 1_500)),
    ])
  } finally {
    disposePlugin?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
    if (originalEndpoint === undefined) delete process.env.HELIX_CONTROL_ENDPOINT
    else process.env.HELIX_CONTROL_ENDPOINT = originalEndpoint
    if (originalToken === undefined) delete process.env.HELIX_CONTROL_TOKEN
    else process.env.HELIX_CONTROL_TOKEN = originalToken
  }
})
