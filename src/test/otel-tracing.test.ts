import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_OTEL_TRACING_ENDPOINT,
  DEFAULT_OTEL_TRACING_SETTINGS,
  OTEL_RESYNC_TRIGGERS,
  isOtelResyncTrigger,
  isOtelTracingSettings,
  isValidOtelEndpointId,
  isValidOtelHeaderName,
  normalizeOtelTracingSettings,
  persistedOtelTracingSettings,
  type OtelTracingSettings,
} from '../shared/otel-tracing.js'

function endpoint(overrides: Partial<OtelTracingSettings['endpoints'][number]> = {}): OtelTracingSettings['endpoints'][number] {
  return { ...DEFAULT_OTEL_TRACING_ENDPOINT, id: 'local', url: 'http://127.0.0.1:4318/v1/traces', ...overrides }
}

test('isOtelTracingSettings accepts well-formed settings and rejects damaged ones', () => {
  const settings: OtelTracingSettings = {
    ...DEFAULT_OTEL_TRACING_SETTINGS,
    endpoints: [endpoint()],
  }
  assert.equal(isOtelTracingSettings(settings), true)

  assert.equal(isOtelTracingSettings(null), false)
  assert.equal(isOtelTracingSettings([]), false)
  assert.equal(isOtelTracingSettings({ ...settings, enabled: 'yes' }), false)
  assert.equal(isOtelTracingSettings({ ...settings, serviceName: 7 }), false)
  assert.equal(isOtelTracingSettings({ ...settings, maxContentLength: 63 }), false, 'below the minimum is rejected')
  assert.equal(isOtelTracingSettings({ ...settings, maxContentLength: 65_537 }), false, 'above the maximum is rejected')
  assert.equal(isOtelTracingSettings({ ...settings, endpoints: [endpoint({ timeoutMs: 99 })] }), false, 'endpoint timeout below the minimum')
  assert.equal(isOtelTracingSettings({ ...settings, endpoints: [endpoint({ protocol: 'http/json' as never })] }), false)
})

test('normalizeOtelTracingSettings falls back field by field', () => {
  assert.deepEqual(normalizeOtelTracingSettings(null), { ...DEFAULT_OTEL_TRACING_SETTINGS, endpoints: [] })
  assert.deepEqual(normalizeOtelTracingSettings('nonsense'), { ...DEFAULT_OTEL_TRACING_SETTINGS, endpoints: [] })

  const normalized = normalizeOtelTracingSettings({
    enabled: true,
    serviceName: 'probe',
    endpoints: [
      { url: 'http://collector:4318/v1/traces', protocol: 'grpc', timeoutMs: 9000 },
      'not-an-object',
    ],
    maxContentLength: 4096,
  })
  assert.equal(normalized.enabled, true)
  assert.equal(normalized.serviceName, 'probe')
  assert.equal(normalized.capturePrompts, false, 'missing flags fall back to the defaults')
  assert.equal(normalized.maxContentLength, 4096)
  assert.deepEqual(normalized.endpoints[0].protocol, 'grpc')
  assert.equal(normalized.endpoints[0].timeoutMs, 9000)
  assert.equal(normalized.endpoints[0].id, 'legacy-0', 'a well-formed endpoint without an id gets one')
  assert.equal(normalized.endpoints[1].id, 'legacy-1')
  assert.equal(normalized.endpoints[1].protocol, 'http/protobuf')
})

test('normalization migrates the pre-fan-out single endpoint setting', () => {
  const normalized = normalizeOtelTracingSettings({
    enabled: false,
    serviceName: 'helix',
    endpoint: 'http://collector:4317',
    protocol: 'grpc',
    exportTimeoutMs: 8000,
  })
  assert.equal(normalized.endpoints.length, 1)
  assert.equal(normalized.endpoints[0].url, 'http://collector:4317')
  assert.equal(normalized.endpoints[0].protocol, 'grpc')
  assert.equal(normalized.endpoints[0].timeoutMs, 8000)

  const outOfRange = normalizeOtelTracingSettings({ endpoint: 'http://collector:4317', exportTimeoutMs: 90 })
  assert.equal(outOfRange.endpoints[0].timeoutMs, DEFAULT_OTEL_TRACING_ENDPOINT.timeoutMs, 'an out-of-range legacy timeout falls back')
})

test('persistedOtelTracingSettings strips webview-only credential state', () => {
  const persisted = persistedOtelTracingSettings({
    ...DEFAULT_OTEL_TRACING_SETTINGS,
    endpoints: [
      endpoint({ authMethod: 'api-key', credentialConfigured: true, credentialDraft: 'secret', clearCredential: true, headerName: '  ' }),
      endpoint({ authMethod: 'none', legacyHeadersEnv: 'OTEL_AUTH_HEADERS' }),
      endpoint({ authMethod: 'none' }),
    ],
  })
  assert.deepEqual(persisted.endpoints[0], {
    id: 'local',
    url: 'http://127.0.0.1:4318/v1/traces',
    protocol: 'http/protobuf',
    authMethod: 'api-key',
    headerName: 'x-api-key',
    timeoutMs: 5000,
  }, 'credential state is dropped and a blank header name falls back')
  assert.deepEqual(persisted.endpoints[1].legacyHeadersEnv, 'OTEL_AUTH_HEADERS', 'legacy header env is retained only with auth none')
  assert.equal('legacyHeadersEnv' in persisted.endpoints[2], false)
})

test('endpoint ids and header names follow the protocol-safe patterns', () => {
  assert.equal(isValidOtelEndpointId('local'), true)
  assert.equal(isValidOtelEndpointId('my-collector_2'), true)
  assert.equal(isValidOtelEndpointId(''), false)
  assert.equal(isValidOtelEndpointId('has space'), false)
  assert.equal(isValidOtelEndpointId('a'.repeat(81)), false)

  assert.equal(isValidOtelHeaderName('x-api-key'), true)
  assert.equal(isValidOtelHeaderName('Authorization'), true)
  assert.equal(isValidOtelHeaderName(''), false)
  assert.equal(isValidOtelHeaderName('bad header'), false)
  assert.equal(isValidOtelHeaderName('h{0}'), false)
})

test('the message-ref settings carry the plugin defaults', () => {
  assert.equal(DEFAULT_OTEL_TRACING_SETTINGS.inputMessagesMode, 'full', 'Helix starts in the mode that reproduces the shipped behaviour')
  assert.equal(DEFAULT_OTEL_TRACING_SETTINGS.maxSpansBetweenResyncs, 16)
  assert.equal(DEFAULT_OTEL_TRACING_SETTINGS.refHashLength, 12)
  assert.equal(DEFAULT_OTEL_TRACING_SETTINGS.refEncoding, 'base64url')
  assert.equal(DEFAULT_OTEL_TRACING_SETTINGS.messageEntryMaxBytes, 8192)
  assert.equal(DEFAULT_OTEL_TRACING_SETTINGS.watermarkMaxEntries, 4096)
  assert.equal(DEFAULT_OTEL_TRACING_SETTINGS.captureSystemPromptSections, true)
  assert.equal(DEFAULT_OTEL_TRACING_SETTINGS.contextPointers, true)
  assert.equal(DEFAULT_OTEL_TRACING_SETTINGS.exportGapResyncs, true)
  assert.deepEqual(DEFAULT_OTEL_TRACING_SETTINGS.resyncOn, ['exportGap', 'unknownEvent'], 'the checkpoint defaults keep only the repairs the structural checks cannot make alone')
})

test('normalizeOtelTracingSettings falls back per message-ref field', () => {
  const normalized = normalizeOtelTracingSettings({
    ...DEFAULT_OTEL_TRACING_SETTINGS,
    inputMessagesMode: 'hashes',
    maxSpansBetweenResyncs: -1,
    refHashLength: 7,
    refEncoding: 'base58',
    messageEntryMaxBytes: 32,
    watermarkMaxEntries: 32,
    captureSystemPromptSections: 'yes',
    contextPointers: null,
    exportGapResyncs: 0,
  })
  assert.equal(normalized.inputMessagesMode, 'full')
  assert.equal(normalized.maxSpansBetweenResyncs, 16)
  assert.equal(normalized.refHashLength, 12)
  assert.equal(normalized.refEncoding, 'base64url')
  assert.equal(normalized.messageEntryMaxBytes, 8192)
  assert.equal(normalized.watermarkMaxEntries, 4096)
  assert.equal(normalized.captureSystemPromptSections, true)
  assert.equal(normalized.contextPointers, true)
  assert.equal(normalized.exportGapResyncs, true)

  const refs = normalizeOtelTracingSettings({
    inputMessagesMode: 'refs',
    maxSpansBetweenResyncs: 0,
    refHashLength: 16,
    refEncoding: 'hex',
  })
  assert.equal(refs.inputMessagesMode, 'refs')
  assert.equal(refs.maxSpansBetweenResyncs, 0, 'zero is a real choice: it checkpoints only at session start')
  assert.equal(refs.refHashLength, 16)
  assert.equal(refs.refEncoding, 'hex')
})

test('normalization keeps known resync triggers in the canonical order', () => {
  assert.deepEqual(normalizeOtelTracingSettings({ resyncOn: ['toolSet', 'userMessage', 'toolSet'] }).resyncOn, ['userMessage', 'toolSet'])
  assert.deepEqual(normalizeOtelTracingSettings({ resyncOn: ['route', 'teleport'] }).resyncOn, ['route'], 'a trigger this build does not know is dropped')
  assert.deepEqual(normalizeOtelTracingSettings({ resyncOn: [] }).resyncOn, [], 'an empty list is kept: layer-2 checkpoints are off')
  assert.deepEqual(normalizeOtelTracingSettings({ resyncOn: 'all' }).resyncOn, ['exportGap', 'unknownEvent'], 'a value that is not an array is treated as unset, so the checkpoint defaults apply')
  assert.equal(OTEL_RESYNC_TRIGGERS.every(isOtelResyncTrigger), true)
  assert.equal(isOtelResyncTrigger('teleport'), false)
})

test('isOtelTracingSettings rejects damaged message-ref settings', () => {
  const settings: OtelTracingSettings = { ...DEFAULT_OTEL_TRACING_SETTINGS, endpoints: [endpoint()] }
  assert.equal(isOtelTracingSettings(settings), true, 'the shipped defaults validate')

  assert.equal(isOtelTracingSettings({ ...settings, inputMessagesMode: 'hashes' as never }), false)
  assert.equal(isOtelTracingSettings({ ...settings, maxSpansBetweenResyncs: 100_001 }), false)
  assert.equal(isOtelTracingSettings({ ...settings, refHashLength: 17 }), false)
  assert.equal(isOtelTracingSettings({ ...settings, refEncoding: 'hexupper' as never }), false)
  assert.equal(isOtelTracingSettings({ ...settings, messageEntryMaxBytes: 63 }), false)
  assert.equal(isOtelTracingSettings({ ...settings, watermarkMaxEntries: 63 }), false)
  assert.equal(isOtelTracingSettings({ ...settings, resyncOn: ['route', 'teleport'] }), false)
  assert.equal(isOtelTracingSettings({ ...settings, contextPointers: 'true' as never }), false)
})

test('persistedOtelTracingSettings keeps every message-ref setting and copies the trigger list', () => {
  const settings: OtelTracingSettings = {
    ...DEFAULT_OTEL_TRACING_SETTINGS,
    inputMessagesMode: 'refs',
    resyncOn: ['userMessage'],
    refEncoding: 'hex',
  }
  const persisted = persistedOtelTracingSettings(settings)
  assert.equal(persisted.inputMessagesMode, 'refs')
  assert.deepEqual(persisted.resyncOn, ['userMessage'])
  assert.equal(persisted.refEncoding, 'hex')

  persisted.resyncOn.push('route')
  assert.deepEqual(settings.resyncOn, ['userMessage'], 'the saved list is not the live list')
})
