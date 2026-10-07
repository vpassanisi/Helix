import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import type { HarnessClient, HarnessClientOptions } from '@deepseek-ai/dsh-sdk-client'
import type { ControlBroker, ControlBridgeOptions } from '../runtime/control-bridge.js'
import { HarnessRuntime } from '../runtime/harness-runtime.js'
import { RequestPreviewCancelledError, RequestPreviewController, type RequestPreviewRuntime } from '../host/request-preview-controller.js'
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
    answerQuestion: async () => undefined,
    start: async () => { calls.push('bridge.start') },
    waitForConnection: async () => connected,
    cancel: async () => undefined,
    resolveApproval: async () => undefined,
    steer: async () => undefined,
    inject: async () => undefined,
    setApprovalPolicy: async () => undefined,
    setSandboxMode: async () => undefined,
    setReasoningEffort: async (sessionId, reasoningEffort) => { calls.push(`bridge.reasoning:${sessionId}:${reasoningEffort ?? 'default'}`) },
    armRequestPreview: async (sessionId, captureId) => { calls.push(`bridge.preview:${sessionId}:${captureId}`) },
    captureNextProviderRequest: async (sessionId) => { calls.push(`bridge.capture-provider-request:${sessionId}`) },
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

test('stages reasoning effort on the running session without restarting DSH', async () => {
  const calls: string[] = []
  const runtime = new HarnessRuntime({
    createControlBridge: (_options: ControlBridgeOptions) => fakeBridge(true, calls),
    createClient: (_options: HarnessClientOptions) => fakeClient(calls),
  })

  await runtime.start(runtimeOptions())
  await runtime.setReasoningEffort('active-session', 'high')
  await runtime.armRequestPreview('active-session', 'capture-id')
  await runtime.prompt('active-session', [])

  assert.deepEqual(calls, [
    'bridge.start',
    'client.start',
    'client.initialize',
    'bridge.reasoning:active-session:high',
    'bridge.preview:active-session:capture-id',
    'client.prompt',
  ])
  await runtime.dispose()
})

test('writes an isolated DSH sessions root into the runtime patch', async () => {
  let clientOptions: HarnessClientOptions | undefined
  const runtime = new HarnessRuntime({
    createControlBridge: (_options: ControlBridgeOptions) => fakeBridge(true, []),
    createClient: (options: HarnessClientOptions) => {
      clientOptions = options
      return fakeClient([])
    },
  })

  await runtime.start({ ...runtimeOptions(), sessionStorageRoot: '/tmp/preview-session-store' })
  const patchPath = clientOptions?.patches?.[0]
  assert.ok(patchPath)
  const patch = await readFile(patchPath, 'utf8')
  assert.match(patch, /- id: sessions\n  config:\n    root: "\/tmp\/preview-session-store"/)
  assert.match(patch, /id: helix-question-tool\n\s+name: "file:.*dsh-question-tool-plugin\.js"/)
  await runtime.dispose()
})

test('writes saved model formats and same-name effort values into the llm-pi-ai route patch', async () => {
  let clientOptions: HarnessClientOptions | undefined
  const runtime = new HarnessRuntime({
    createControlBridge: (_options: ControlBridgeOptions) => fakeBridge(true, []),
    createClient: (options: HarnessClientOptions) => {
      clientOptions = options
      return fakeClient([])
    },
  })

  await runtime.start({
    ...runtimeOptions(),
    provider: 'muse-gateway',
    savedModels: [
      {
        id: 'muse/glimmer',
        displayName: 'Muse Glimmer',
        contextWindow: 65536,
        acceptsImages: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        reasoningFormat: 'deepseek',
      },
      {
        id: 'muse/template',
        reasoningFormat: 'chat-template',
        reasoningEfforts: ['low', 'medium', 'high'],
        chatTemplateKwargs: { effort: { $var: 'thinking.effort' }, enabled: true },
      },
    ],
  })

  const patchPath = clientOptions?.patches?.[0]
  assert.ok(patchPath)
  const patch = await readFile(patchPath, 'utf8')
  assert.match(patch, /"muse-gateway":\n        models:/)
  assert.match(patch, /- id: "muse\/glimmer"\n            name: "Muse Glimmer"\n            contextWindow: 65536/)
  assert.match(patch, /"muse\/glimmer"[\s\S]*?input: \["text", "image"\]/)
  assert.match(patch, /"muse\/template"\n            input: \["text"\]/)
  assert.match(patch, /"medium": "medium"/)
  assert.match(patch, /thinkingFormat: "deepseek"/)
  assert.match(patch, /"muse\/template"[\s\S]*?chatTemplateKwargs:[\s\S]*?\$var: "thinking\.effort"/)
  await runtime.dispose()
})

test('does not send llm-pi-ai model formats through the fixed deepseek-official route', async () => {
  let clientOptions: HarnessClientOptions | undefined
  const runtime = new HarnessRuntime({
    createControlBridge: (_options: ControlBridgeOptions) => fakeBridge(true, []),
    createClient: (options: HarnessClientOptions) => {
      clientOptions = options
      return fakeClient([])
    },
  })
  await runtime.start({
    ...runtimeOptions(),
    provider: 'deepseek-official',
    savedModels: [{ id: 'model-a', reasoningFormat: 'deepseek', reasoningEfforts: ['low', 'medium', 'high'] }],
  })
  const patchPath = clientOptions?.patches?.[0]
  assert.ok(patchPath)
  const patch = await readFile(patchPath, 'utf8')
  assert.doesNotMatch(patch, /thinkingFormat:|"deepseek-official":/)
  assert.match(patch, /- id: "model-a"\n        inputModalities: \["text"\]/)
  await runtime.dispose()
})

test('direct DeepSeek Vision settings preserve built-in metadata and add custom models', async () => {
  let clientOptions: HarnessClientOptions | undefined
  const runtime = new HarnessRuntime({
    createControlBridge: (_options: ControlBridgeOptions) => fakeBridge(true, []),
    createClient: (options: HarnessClientOptions) => {
      clientOptions = options
      return fakeClient([])
    },
  })

  await runtime.start({
    ...runtimeOptions(),
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    contextWindow: 65536,
    savedModels: [
      { id: 'deepseek-flash', acceptsImages: false },
      { id: 'custom-vision', acceptsImages: true },
    ],
  })

  const patchPath = clientOptions?.patches?.[0]
  assert.ok(patchPath)
  const patch = await readFile(patchPath, 'utf8')
  const builtIn = patch.split('      - id: "deepseek-flash"')[1]?.split('      - id: ')[0]
  assert.ok(builtIn)
  assert.match(builtIn, /name: "DeepSeek-V41-Flash"/)
  assert.match(builtIn, /contextWindow: 65536/)
  assert.match(builtIn, /inputModalities: \["text"\]/)
  assert.match(builtIn, /systemPromptUpdate: "in-history"/)
  assert.doesNotMatch(builtIn, /imagePixelBudget:|imageMaxBytes:/)
  assert.match(patch, /- id: "custom-vision"\n        inputModalities: \["text", "image"\]/)
  assert.match(patch, /- id: "deepseek-v4-flash-vision-exp"[\s\S]*?inputModalities: \["text", "image"\]/)
  await runtime.dispose()
})

test('previews the selected route and fresh-chat default effort, then removes temporary session data', async () => {
  let startedOptions: RuntimeOptions | undefined
  let stagedEffort: string | null | undefined
  let stagedCapture: { sessionId: string; captureId: string } | undefined
  let promptData: { sessionId: string; blocks: Array<{ type: 'text'; text: string }> } | undefined
  let disposed = false
  let sessionRoot: string | undefined
  const controller = new RequestPreviewController({
    getRuntimeOptions: async () => ({ ...runtimeOptions(), provider: 'selected-route', model: 'selected-model', dshHome: '/tmp/dsh-home' }),
    resolveReasoningEffort: async () => 'configured-default',
    createRuntime: (onControlEvent) => ({
      start: async (options) => { startedOptions = options; sessionRoot = options.sessionStorageRoot },
      setReasoningEffort: async (sessionId, effort) => { stagedEffort = effort; assert.ok(sessionId) },
      armRequestPreview: async (sessionId, captureId) => { stagedCapture = { sessionId, captureId } },
      prompt: async (sessionId, blocks) => {
        promptData = { sessionId, blocks }
        assert.ok(sessionRoot)
        await access(sessionRoot)
        onControlEvent({
          eventId: 'capture-event',
          sessionId,
          method: 'request.previewCaptured',
          params: {
            captureId: stagedCapture?.captureId,
            request: {
              provider: 'selected-route',
              model: 'selected-model',
              reasoningEffort: stagedEffort,
              messages: [{ role: 'user', content: [{ type: 'text', text: 'preview this request' }] }],
            },
            promptBreakdown: {
              systemSections: [{ name: 'harness:identity', text: 'Harness identity.' }],
              contextSections: [{ name: 'skills:catalog', text: 'Available skills.' }],
            },
          },
        })
        return 'preview-turn'
      },
      dispose: async () => { disposed = true },
    } satisfies RequestPreviewRuntime),
  })

  const preview = await controller.run('  preview this request  ')
  assert.equal(startedOptions?.provider, 'selected-route')
  assert.equal(startedOptions?.model, 'selected-model')
  assert.equal(startedOptions?.dshHome, '/tmp/dsh-home')
  assert.ok(startedOptions?.sessionStorageRoot)
  assert.equal(stagedEffort, 'configured-default')
  assert.deepEqual(promptData?.blocks, [{ type: 'text', text: 'preview this request' }])
  assert.equal(preview.request.provider, 'selected-route')
  assert.equal(preview.request.model, 'selected-model')
  assert.equal(preview.request.reasoningEffort, 'configured-default')
  assert.deepEqual(preview.promptBreakdown?.systemSections, [{ name: 'harness:identity', text: 'Harness identity.' }])
  assert.equal(disposed, true)
  await assert.rejects(access(sessionRoot!), { code: 'ENOENT' })
})

test('request preview reports startup failures and removes its temporary sessions root', async () => {
  let sessionRoot: string | undefined
  let disposed = false
  const controller = new RequestPreviewController({
    getRuntimeOptions: async () => runtimeOptions(),
    resolveReasoningEffort: async () => undefined,
    createRuntime: () => ({
      start: async (options) => { sessionRoot = options.sessionStorageRoot; throw new Error('preview startup failed') },
      setReasoningEffort: async () => undefined,
      armRequestPreview: async () => undefined,
      prompt: async () => 'unused',
      dispose: async () => { disposed = true },
    }),
  })

  await assert.rejects(controller.run('hello'), /preview startup failed/)
  assert.equal(disposed, true)
  await assert.rejects(access(sessionRoot!), { code: 'ENOENT' })
})

test('request preview reports capture failures and removes its temporary sessions root', async () => {
  let sessionRoot: string | undefined
  let disposed = false
  const controller = new RequestPreviewController({
    getRuntimeOptions: async () => runtimeOptions(),
    resolveReasoningEffort: async () => undefined,
    createRuntime: () => ({
      start: async (options) => { sessionRoot = options.sessionStorageRoot },
      setReasoningEffort: async () => undefined,
      armRequestPreview: async () => undefined,
      prompt: async () => { throw new Error('DSH request capture failed') },
      dispose: async () => { disposed = true },
    }),
  })

  await assert.rejects(controller.run('hello'), /DSH request capture failed/)
  assert.equal(disposed, true)
  await assert.rejects(access(sessionRoot!), { code: 'ENOENT' })
})

test('cancelling a request preview disposes the runtime and removes temporary sessions', async () => {
  let sessionRoot: string | undefined
  let resolvePromptStarted!: () => void
  const promptStarted = new Promise<void>((resolve) => { resolvePromptStarted = resolve })
  let disposed = false
  const controller = new RequestPreviewController({
    getRuntimeOptions: async () => runtimeOptions(),
    resolveReasoningEffort: async () => undefined,
    createRuntime: () => ({
      start: async (options) => { sessionRoot = options.sessionStorageRoot },
      setReasoningEffort: async () => undefined,
      armRequestPreview: async () => undefined,
      prompt: async () => { resolvePromptStarted(); return await new Promise<string>(() => undefined) },
      dispose: async () => { disposed = true },
    }),
  })

  const preview = controller.run('hello')
  await promptStarted
  await controller.cancel()
  await assert.rejects(preview, RequestPreviewCancelledError)
  assert.equal(disposed, true)
  await assert.rejects(access(sessionRoot!), { code: 'ENOENT' })
})
