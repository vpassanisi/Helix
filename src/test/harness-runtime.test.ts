import assert from 'node:assert/strict'
import test from 'node:test'
import type { HarnessClient, HarnessClientOptions } from '@deepseek-ai/dsh-sdk-client'
import type { ControlBroker, ControlBridgeOptions } from '../runtime/control-bridge.js'
import { HarnessRuntime } from '../runtime/harness-runtime.js'
import type { RuntimeOptions } from '../runtime/types.js'

function runtimeOptions(): RuntimeOptions {
  return {
    cwd: process.cwd(),
    provider: 'test-provider',
    model: 'test-model',
    sandboxMode: 'workspace-write',
    mcpServers: [],
  }
}

function fakeBridge(connected: boolean, calls: string[]): ControlBroker {
  return {
    endpoint: 'test-endpoint',
    token: 'test-token',
    connected,
    capabilities: [],
    start: async () => { calls.push('bridge.start') },
    waitForConnection: async () => connected,
    cancel: async () => undefined,
    resolveApproval: async () => undefined,
    steer: async () => undefined,
    inject: async () => undefined,
    setApprovalPolicy: async () => undefined,
    setSandboxMode: async () => undefined,
    close: async () => { calls.push('bridge.close') },
  }
}

function fakeClient(calls: string[], promptError?: Error): HarnessClient {
  return {
    start: () => { calls.push('client.start') },
    initialize: async () => { calls.push('client.initialize') },
    prompt: async () => {
      calls.push('client.prompt')
      if (promptError !== undefined) throw promptError
      return 'turn-1'
    },
    close: async () => { calls.push('client.close') },
    subscribeSessionTree: () => ({
      close: () => undefined,
      async *[Symbol.asyncIterator]() { /* no notifications */ },
    }),
  } as unknown as HarnessClient
}

test('fails startup when the bridge does not handshake and can retry cleanly', async () => {
  const calls: string[] = []
  let bridgeCount = 0
  const runtime = new HarnessRuntime({
    createControlBridge: (_options: ControlBridgeOptions) => fakeBridge(++bridgeCount > 1, calls),
    createClient: (_options: HarnessClientOptions) => fakeClient(calls),
  })

  await assert.rejects(runtime.start(runtimeOptions()), (error: { code?: string }) => error.code === 'BRIDGE_TIMEOUT')
  assert.equal(runtime.currentState, 'error')
  assert.deepEqual(calls, ['bridge.start', 'client.start', 'client.initialize', 'client.close', 'bridge.close'])

  await runtime.start(runtimeOptions())
  assert.equal(runtime.currentState, 'ready')
  assert.equal(await runtime.prompt('session', []), 'turn-1')
  await runtime.stop()
  assert.equal(runtime.currentState, 'stopped')
})

test('cleans up a client that fails while prompting', async () => {
  const calls: string[] = []
  const runtime = new HarnessRuntime({
    createControlBridge: (_options: ControlBridgeOptions) => fakeBridge(true, calls),
    createClient: (_options: HarnessClientOptions) => fakeClient(calls, new Error('client disconnected')),
  })

  await runtime.start(runtimeOptions())
  await assert.rejects(runtime.prompt('session', []), /client disconnected/)
  assert.equal(runtime.currentState, 'error')
  assert.equal(calls.filter((call) => call === 'client.close').length, 1)
  await runtime.dispose()
})
