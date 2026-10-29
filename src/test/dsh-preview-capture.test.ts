import assert from 'node:assert/strict'
import test from 'node:test'
import { DshPreviewCapture } from '../runtime/dsh-preview-capture.js'

interface Emission {
  sessionId: string
  method: 'request.previewCaptured' | 'provider.requestCaptured'
  params: Record<string, unknown>
}

function captureFactory() {
  const emissions: Emission[] = []
  const capture = new DshPreviewCapture((sessionId, method, params) => {
    emissions.push({ sessionId, method, params })
    return true
  })
  return { capture, emissions }
}

const drain = async (stream: AsyncIterable<unknown>): Promise<unknown[]> => {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('an armed session is reported and replaced by an immediate stop', async () => {
  const { capture, emissions } = captureFactory()
  capture.arm('session-a', { captureId: 'cap-1' })

  const passthrough = (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
  const chunks = await drain(capture.onLlmStream({
    sessionId: 'session-a',
    provider: 'test-provider',
    model: 'test-model',
    reasoningEffort: 'high',
    messages: [{ role: 'user', content: 'hi' }],
    system: 'sys',
    tools: [{ name: 'read_file' }],
    temperature: 0.2,
    maxTokens: 100,
    stop: ['x'],
  }, () => passthrough))

  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(emissions.length, 1)
  assert.equal(emissions[0].sessionId, 'session-a')
  assert.equal(emissions[0].method, 'request.previewCaptured')
  assert.equal(emissions[0].params.captureId, 'cap-1')
  assert.deepEqual(emissions[0].params.request, {
    provider: 'test-provider',
    model: 'test-model',
    reasoningEffort: 'high',
    messages: [{ role: 'user', content: 'hi' }],
    system: 'sys',
    tools: [{ name: 'read_file' }],
    temperature: 0.2,
    maxTokens: 100,
    stop: ['x'],
  })

  // The capture is one-shot: the next request goes to the adapter.
  const nextChunks: unknown[] = []
  const next = (async function* () {
    nextChunks.push({ type: 'finish', reason: { kind: 'end' } })
    yield { type: 'finish', reason: { kind: 'end' } }
  })()
  await drain(capture.onLlmStream({ sessionId: 'session-a', provider: 'p', model: 'm', messages: [] }, () => next))
  assert.equal(emissions.length, 1, 'only the first matching request is captured')
  assert.equal(nextChunks.length, 1, 'later requests reach the adapter')
})

test('requests with a purpose and unarm sessions pass through untouched', async () => {
  const { capture, emissions } = captureFactory()
  capture.arm('session-a', { captureId: 'cap-1' })

  const seen: string[] = []
  const next = () => (async function* () { seen.push('adapter'); yield {} })()
  await drain(capture.onLlmStream({ sessionId: 'session-a', purpose: 'session-title', provider: 'p', model: 'm', messages: [] }, next))
  await drain(capture.onLlmStream({ sessionId: 'session-b', provider: 'p', model: 'm', messages: [] }, next))
  await drain(capture.onLlmStream({ provider: 'p', model: 'm', messages: [] }, next))
  assert.deepEqual(seen, ['adapter', 'adapter', 'adapter'])
  assert.equal(emissions.length, 0, 'the armed capture is still pending')
})

test('arm requires a capture id', () => {
  const { capture } = captureFactory()
  assert.throws(() => capture.arm('session-a', {}), (error: { code?: string }) => error.code === 'INVALID_ARGUMENT')
})

test('the recorded prompt breakdown ships with the captured request', async () => {
  const { capture, emissions } = captureFactory()
  capture.arm('session-a', { captureId: 'cap-1' })
  capture.recordPromptBreakdown({
    sections: [
      { name: 'harness:identity', text: 'Identity at {{workspace}}' },
      { name: 'empty-section', text: '' },
    ],
    contexts: [{ name: 'workspace:state', text: 'State of {{workspace}}' }],
    tools: [],
    variables: { workspace: '/w' },
  }, 'session-a')
  capture.recordPromptBreakdown('not-an-assembly', 'session-b')

  await drain(capture.onLlmStream({ sessionId: 'session-a', provider: 'p', model: 'm', messages: [] }, () => (async function* () { yield {} })()))
  assert.equal(emissions.length, 1)
  assert.deepEqual(emissions[0].params.promptBreakdown, {
    systemSections: [{ name: 'harness:identity', text: 'Identity at /w' }],
    contextSections: [{ name: 'workspace:state', text: 'State of /w' }],
  })
})

test('provider request capture arms one session and reports the call', () => {
  const { capture, emissions } = captureFactory()
  capture.captureNextProviderRequest('session-a')
  assert.equal(capture.providerRequestCaptureSessionId, 'session-a')

  capture.handleProviderCapture('session-a', 'https://api.example.com/v1/chat/completions', '{"model":"x"}')
  assert.equal(capture.providerRequestCaptureSessionId, undefined)
  assert.equal(emissions.length, 1)
  assert.equal(emissions[0].method, 'provider.requestCaptured')
  assert.equal(emissions[0].sessionId, 'session-a')
  assert.deepEqual(emissions[0].params, {
    url: 'https://api.example.com/v1/chat/completions',
    body: '{"model":"x"}',
  })
})

test('clear resets previews, breakdowns, and provider capture', async () => {
  const { capture, emissions } = captureFactory()
  capture.arm('session-a', { captureId: 'cap-1' })
  capture.captureNextProviderRequest('session-a')
  capture.clear()

  assert.equal(capture.providerRequestCaptureSessionId, undefined)
  await drain(capture.onLlmStream({ sessionId: 'session-a', provider: 'p', model: 'm', messages: [] }, () => (async function* () { yield {} })()))
  assert.equal(emissions.length, 0, 'a cleared capture no longer intercepts')
})
