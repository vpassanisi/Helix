import assert from 'node:assert/strict'
import test from 'node:test'
import helixControlPlugin from '../runtime/dsh-control-plugin.js'
import { LocalControlBridge } from '../runtime/control-bridge.js'

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
      },
      effect: (factory: () => () => void) => { disposePlugin = factory() },
    })
    assert.equal(await bridge.waitForConnection(), true)

    await bridge.cancel('root-session')
    assert.equal(cancelCalls.length, 1)
    assert.deepEqual(cancelCalls[0], [{ kind: 'user' }, { keepInbox: false }])

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
    await bridge.resolveApproval('root-session', await approvalEvent, 'allowed-once')
    eventDisposable.dispose()
    assert.equal(await approvalPromise, 'allowed-once')
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
