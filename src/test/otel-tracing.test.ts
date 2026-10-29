import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_OTEL_TRACING_ENDPOINT,
  DEFAULT_OTEL_TRACING_SETTINGS,
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
