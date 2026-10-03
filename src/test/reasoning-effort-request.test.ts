import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HarnessRuntime } from '../runtime/harness-runtime.js'
import {
  parseSavedModelCatalogJson,
  resolveSavedModelReasoningEffort,
  serializeSavedModelCatalog,
  type SavedModel,
} from '../runtime/model-catalog.js'
import type { RoutedNotification } from '../runtime/types.js'

interface CapturedRequest {
  path: string
  body: Record<string, unknown>
}

interface RequestWaiter {
  resolve: (request: CapturedRequest | undefined) => void
  timer: ReturnType<typeof setTimeout>
}

interface RecordingEndpoint {
  baseUrl: string
  waitForRequest(): { promise: Promise<CapturedRequest | undefined>; cancel(): void }
  close(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function createRecordingEndpoint(): Promise<RecordingEndpoint> {
  const captured: CapturedRequest[] = []
  const waiters: RequestWaiter[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    request.on('end', () => {
      let body: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!isRecord(parsed)) throw new Error('The provider request body was not an object.')
        body = parsed
      } catch {
        response.writeHead(400)
        response.end('Expected a JSON request body.')
        return
      }

      const recorded: CapturedRequest = { path: request.url ?? '', body }
      const waiter = waiters.shift()
      if (waiter !== undefined) {
        clearTimeout(waiter.timer)
        waiter.resolve(recorded)
      } else {
        captured.push(recorded)
      }

      const model = typeof body.model === 'string' ? body.model : 'test-model'
      const chunk = (delta: Record<string, unknown>, finishReason: string | null) => JSON.stringify({
        id: 'chatcmpl-reasoning-effort-test',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      })
      response.end([
        'data: ' + chunk({ role: 'assistant', content: 'Captured request.' }, null),
        '',
        'data: ' + chunk({}, 'stop'),
        '',
        'data: [DONE]',
        '',
      ].join('\n'))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  return {
    baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
    waitForRequest() {
      const ready = captured.shift()
      if (ready !== undefined) return { promise: Promise.resolve(ready), cancel: () => undefined }

      let waiter: RequestWaiter | undefined
      const promise = new Promise<CapturedRequest | undefined>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (waiter !== undefined) {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
          }
          reject(new Error('Timed out waiting for the provider request.'))
        }, 20_000)
        waiter = { resolve, timer }
        waiters.push(waiter)
      })
      return {
        promise,
        cancel() {
          if (waiter === undefined) return
          const index = waiters.indexOf(waiter)
          if (index >= 0) {
            waiters.splice(index, 1)
            clearTimeout(waiter.timer)
            waiter.resolve(undefined)
          }
        },
      }
    },
    close() {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.resolve(undefined)
      }
      return new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
    },
  }
}

function createIdleWaiter(): {
  promise: Promise<void>
  observe(status: unknown): void
  dispose(): void
} {
  let sawRunning = false
  let resolvePromise!: () => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  const timer = setTimeout(() => rejectPromise(new Error('Timed out waiting for the DSH turn to finish.')), 20_000)
  return {
    promise,
    observe(status) {
      if (status === 'running') sawRunning = true
      if (status === 'idle' && sawRunning) {
        clearTimeout(timer)
        resolvePromise()
      }
    },
    dispose() {
      clearTimeout(timer)
    },
  }
}

function savedModel(format: 'openai' | 'chat-template', id: string): SavedModel {
  return {
    id,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    reasoningFormat: format,
    ...(format === 'chat-template'
      ? { chatTemplateKwargs: { reasoning_strength: { $var: 'thinking.effort' as const } } }
      : {}),
  }
}

test('sends saved reasoning efforts in the configured OpenAI and chat-template request fields', { timeout: 120_000 }, async () => {
  const endpoint = await createRecordingEndpoint()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'helix-reasoning-effort-'))
  const dshHome = join(temporaryRoot, 'dsh-home')
  const workspace = join(temporaryRoot, 'workspace')
  await mkdir(dshHome)
  await mkdir(workspace)
  const provider = 'helix-capture-test'
  const dshSettings = [
    'llm-pi-ai:',
    '  providers:',
    '    ' + provider + ':',
    '      api: openai-completions',
    '      baseURL: ' + JSON.stringify(endpoint.baseUrl),
    '      apiKeyEnv: DEEPSEEK_API_KEY',
    '',
  ].join('\n')
  await writeFile(join(dshHome, 'settings.yaml'), dshSettings, 'utf8')

  try {
    for (const configuredModel of [
      savedModel('openai', 'test/openai-effort-model'),
      savedModel('chat-template', 'test/template-effort-model'),
    ]) {
      // Round-trip the same catalog JSON shape written by Settings before starting DSH.
      const models = parseSavedModelCatalogJson(serializeSavedModelCatalog([configuredModel]))
      const model = models[0]!
      const runtime = new HarnessRuntime()
      const sessionId = randomUUID()
      let currentTurn: ReturnType<typeof createIdleWaiter> | undefined
      const sessionRoute = runtime.registerSession(sessionId, (routed: RoutedNotification) => {
        if (routed.notification.method !== 'session.status') return
        const params = routed.notification.params ?? {}
        if (params.sessionId === sessionId) currentTurn?.observe(params.status)
      })

      try {
        await runtime.start({
          cwd: workspace,
          provider,
          model: model.id,
          apiKey: 'local-test-key',
          dshHome,
          savedModels: models,
          sandboxMode: 'workspace-write',
          mcpServers: [],
        })

        // A null composer selection resolves to the highest configured level; the
        // remaining selections exercise every level in the same chat session.
        for (const selection of [null, ...(model.reasoningEfforts ?? [])]) {
          const expectedEffort = resolveSavedModelReasoningEffort(models, model.id, selection)
          assert.ok(expectedEffort, 'the highest configured level and explicit levels resolve to an effort ID')
          const requestWaiter = endpoint.waitForRequest()
          const turnWaiter = createIdleWaiter()
          currentTurn = turnWaiter
          try {
            await runtime.setReasoningEffort(sessionId, expectedEffort)
            await runtime.prompt(sessionId, [{ type: 'text', text: 'Check reasoning effort ' + expectedEffort }])
            const captured = await requestWaiter.promise
            assert.ok(captured, 'the local endpoint received a completion request')
            assert.match(captured.path, /\/chat\/completions\/?$/)
            assert.equal(captured.body.model, model.id)

            if (model.reasoningFormat === 'openai') {
              assert.equal(captured.body.reasoning_effort, expectedEffort)
              assert.equal('chat_template_kwargs' in captured.body, false)
            } else {
              const templateKwargs = captured.body.chat_template_kwargs
              assert.ok(isRecord(templateKwargs), 'chat-template settings appear under chat_template_kwargs')
              assert.equal(templateKwargs.reasoning_strength, expectedEffort)
              assert.equal('reasoning_effort' in captured.body, false)
            }
            await turnWaiter.promise
          } finally {
            currentTurn = undefined
            requestWaiter.cancel()
            turnWaiter.dispose()
          }
        }
      } finally {
        sessionRoute.dispose()
        await runtime.dispose()
      }
    }
  } finally {
    await endpoint.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
