import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import type { OtelTracingEndpoint, OtelTracingSettings } from '../shared/otel-tracing.js'

// Isolated VS Code API fixture: the configuration reads come from a values Map.
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === 'vscode' ? { url: 'mock:vscode', shortCircuit: true } : next(specifier, context) },
  load(url, context, next) {
    if (url !== 'mock:vscode') return next(url, context)
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export const values = new Map();
        export const workspace = {
          getConfiguration: (prefix) => ({ get: (key, fallback) => values.get(prefix ? prefix + '.' + key : key) ?? fallback })
        };
      `,
    }
  },
})
const {
  buildRuntimeTracingConfig,
  buildSidebarTracingSettings,
  otelEndpointSecretKey,
  resolveLegacyHeaders,
  syncTracingSecrets,
  tracingCredentialHeaders,
  validateGrpcTarget,
  validateTracingSecrets,
  validateTracingEndpoints,
} = await import('../host/tracing-settings.js')
const vscode = await import('vscode') as unknown as { values: Map<string, unknown> }

interface SecretStore {
  store: Map<string, string>
  deleted: string[]
  api: {
    get: (key: string) => Promise<string | undefined>
    store: (key: string, value: string) => Promise<void>
    delete: (key: string) => Promise<void>
  }
}

function secretStore(initial: Record<string, string> = {}): SecretStore {
  const store = new Map(Object.entries(initial))
  const deleted: string[] = []
  return {
    store,
    deleted,
    api: {
      get: async (key) => store.get(key),
      store: async (key, value) => { store.set(key, value) },
      delete: async (key) => { store.delete(key); deleted.push(key) },
    },
  }
}

function endpoint(overrides: Partial<OtelTracingEndpoint> = {}): OtelTracingEndpoint {
  return {
    id: 'local',
    url: 'http://127.0.0.1:4318/v1/traces',
    protocol: 'http/protobuf',
    authMethod: 'none',
    headerName: 'x-api-key',
    timeoutMs: 5000,
    credentialConfigured: false,
    credentialDraft: '',
    clearCredential: false,
    ...overrides,
  }
}

function settings(overrides: Partial<OtelTracingSettings> = {}): OtelTracingSettings {
  return {
    enabled: false,
    serviceName: 'helix',
    endpoints: [],
    capturePrompts: false,
    captureResponses: false,
    captureToolArguments: false,
    maxContentLength: 8192,
    ...overrides,
  }
}

test('endpoint credentials are keyed per endpoint id', () => {
  assert.equal(otelEndpointSecretKey('local'), 'deepseekHarness.otelTracing.endpoint.local.credential')
  assert.equal(otelEndpointSecretKey('a_b-1'), 'deepseekHarness.otelTracing.endpoint.a_b-1.credential')
})

test('resolveLegacyHeaders parses the environment variable header list', () => {
  assert.deepEqual(resolveLegacyHeaders(undefined), {})
  assert.deepEqual(resolveLegacyHeaders('  '), {})

  const name = `HELIX_TEST_OTEL_HEADERS_${Date.now()}`
  process.env[name] = 'x-api-key=abc, x-trace = on'
  try {
    assert.deepEqual(resolveLegacyHeaders(name), { 'x-api-key': 'abc', 'x-trace': 'on' })
  } finally {
    delete process.env[name]
  }

  assert.throws(() => resolveLegacyHeaders(name), /is required/)
  process.env[name] = 'no-separator'
  assert.throws(() => resolveLegacyHeaders(name), /key=value pairs/)
  process.env[name] = 'bad header=value'
  assert.throws(() => resolveLegacyHeaders(name), /Invalid header/)
  delete process.env[name]
})

test('tracingCredentialHeaders maps the auth method to headers', () => {
  assert.deepEqual(tracingCredentialHeaders(endpoint(), undefined), {})
  assert.deepEqual(tracingCredentialHeaders(endpoint({ authMethod: 'bearer' }), 'tok'), { authorization: 'Bearer tok' })
  assert.deepEqual(tracingCredentialHeaders(endpoint({ authMethod: 'api-key' }), 'tok'), { 'x-api-key': 'tok' })
  assert.deepEqual(tracingCredentialHeaders(endpoint({ authMethod: 'api-key', headerName: '  ' }), 'tok'), { 'x-api-key': 'tok' })
  assert.throws(() => tracingCredentialHeaders(endpoint({ url: 'http://x' }), 'a\nb'), /line break/)
})

test('validateTracingEndpoints enforces ids, URLs, and auth rules', () => {
  validateTracingEndpoints(settings({ enabled: true, endpoints: [endpoint()] }))
  validateTracingEndpoints(settings({ enabled: true, endpoints: [endpoint({ protocol: 'grpc', url: 'collector:4317' })] }))
  validateTracingEndpoints(settings({ enabled: true, endpoints: [endpoint({ protocol: 'grpc', url: 'unix:///tmp/otel.sock' })] }))
  // A disabled tracing block may keep empty endpoints: no throw.
  validateTracingEndpoints(settings({ endpoints: [endpoint({ url: '' })] }))

  assert.throws(() => validateTracingEndpoints(settings({ enabled: true, endpoints: [endpoint({ url: '' })] })), /needs an endpoint/)
  assert.throws(() => validateTracingEndpoints(settings({ enabled: true, endpoints: [endpoint({ id: '' })] })), /invalid ID/)
  assert.throws(() => validateTracingEndpoints(settings({ enabled: true, endpoints: [endpoint({ id: 'a' }), endpoint({ id: 'a' })] })), /duplicate ID/)
  assert.throws(() => validateTracingEndpoints(settings({ enabled: true, endpoints: [endpoint({ authMethod: 'api-key', headerName: 'bad header' })] })), /header/)
  assert.throws(() => validateTracingEndpoints(settings({ enabled: true, endpoints: [endpoint({ authMethod: 'bearer', credentialDraft: 'a\nb' })] })), /line break/)
  assert.throws(() => validateTracingEndpoints(settings({ enabled: true, endpoints: [endpoint({ timeoutMs: 99 })] })), /timeout/)
})

test('validateGrpcTarget accepts host forms and unix sockets', () => {
  validateGrpcTarget('collector:4317', 1)
  validateGrpcTarget('https://collector:4317', 1)
  validateGrpcTarget('unix:///tmp/otel.sock', 1)
  assert.throws(() => validateGrpcTarget('unix://', 1), /valid gRPC target/)
  assert.throws(() => validateGrpcTarget('ftp://collector', 1), /valid gRPC target/)
})

test('validateTracingSecrets requires a credential for authenticated endpoints', async () => {
  const secrets = secretStore()

  await validateTracingSecrets(settings({ endpoints: [endpoint()] }), secrets.api as never)
  await validateTracingSecrets(settings({ enabled: true, endpoints: [endpoint({ authMethod: 'bearer', credentialDraft: 'typed' })] }), secrets.api as never)

  assert.rejects(
    validateTracingSecrets(settings({ enabled: true, endpoints: [endpoint({ authMethod: 'bearer' })] }), secrets.api as never),
    /Enter a credential/,
  )
  assert.rejects(
    validateTracingSecrets(settings({ enabled: true, endpoints: [endpoint({ authMethod: 'api-key', clearCredential: true })] }), secrets.api as never),
    /needs a credential/,
  )

  const saved = secretStore({ [otelEndpointSecretKey('local')]: 'stored-tok' })
  await validateTracingSecrets(settings({ enabled: true, endpoints: [endpoint({ authMethod: 'bearer' })] }), saved.api as never)
})

test('syncTracingSecrets stores drafts and clears abandoned credentials', async () => {
  const values = vscode.values
  values.clear()
  values.set('deepseekHarness.otelTracing', {
    enabled: true,
    serviceName: 'helix',
    endpoints: [
      { id: 'gone', url: 'http://a:4318', protocol: 'http/protobuf', authMethod: 'bearer', headerName: 'x-api-key', timeoutMs: 5000, credentialConfigured: true, credentialDraft: '', clearCredential: false },
      { id: 'kept', url: 'http://b:4318', protocol: 'http/protobuf', authMethod: 'api-key', headerName: 'x-api-key', timeoutMs: 5000, credentialConfigured: true, credentialDraft: '', clearCredential: false },
    ],
  })
  const secrets = secretStore({
    [otelEndpointSecretKey('gone')]: 'gone-credential',
    [otelEndpointSecretKey('kept')]: 'kept-credential',
  })

  await syncTracingSecrets({
    ...settings({ enabled: true }),
    endpoints: [
      { ...endpoint({ id: 'kept', authMethod: 'api-key' }), clearCredential: true },
      endpoint({ id: 'fresh', authMethod: 'bearer', credentialDraft: 'fresh-credential' }),
    ],
  }, secrets.api as never)

  assert.equal(secrets.store.get(otelEndpointSecretKey('gone')), undefined)
  assert.ok(secrets.deleted.includes(otelEndpointSecretKey('gone')), 'the abandoned endpoint loses its credential')
  assert.ok(secrets.deleted.includes(otelEndpointSecretKey('kept')), 'clearCredential drops the stored value')
  assert.equal(secrets.store.get(otelEndpointSecretKey('fresh')), 'fresh-credential')
})

test('buildRuntimeTracingConfig resolves credentials and drops empty endpoints', async () => {
  const values = vscode.values
  values.clear()
  values.set('deepseekHarness.otelTracing', {
    enabled: true,
    serviceName: ' helix ',
    endpoints: [
      endpoint({ id: 'a', authMethod: 'api-key', credentialConfigured: true }),
      endpoint({ id: 'b', url: '' }),
    ],
    capturePrompts: true,
    captureResponses: true,
    captureToolArguments: true,
    maxContentLength: 2048,
  })
  const secrets = secretStore({ [otelEndpointSecretKey('a')]: 'stored-a' })

  const config = await buildRuntimeTracingConfig(secrets.api as never)
  const endpoints = config.endpoints as Array<{ protocol: string; headers?: Record<string, string> }>

  assert.equal(config.enabled, true)
  assert.equal(config.serviceName, 'helix')
  assert.equal(config.capturePrompts, true)
  assert.equal(config.maxContentLength, 2048)
  assert.equal(endpoints.length, 1, 'the empty endpoint is filtered out')
  assert.equal(endpoints[0].protocol, 'http/protobuf')
  assert.deepEqual(endpoints[0].headers, { 'x-api-key': 'stored-a' })
})

test('buildSidebarTracingSettings reports configured credentials without values', async () => {
  const values = vscode.values
  values.clear()
  values.set('deepseekHarness.otelTracing', {
    ...settings({ enabled: true }),
    endpoints: [
      endpoint({ id: 'a', authMethod: 'api-key', credentialDraft: 'should-not-ship' }),
      endpoint({ id: 'b', authMethod: 'bearer', credentialDraft: 'draft-b' }),
    ],
  })
  const secrets = secretStore({ [otelEndpointSecretKey('a')]: 'stored-a' })

  const sidebar = await buildSidebarTracingSettings(secrets.api as never)

  assert.equal(sidebar.endpoints.length, 2)
  assert.equal(sidebar.endpoints[0].credentialDraft, '', 'drafts never leave the host')
  assert.equal(sidebar.endpoints[0].credentialConfigured, true, 'a stored credential counts as configured')
  assert.equal(sidebar.endpoints[1].credentialConfigured, false, 'without a stored credential only the draft knows')
  assert.equal(sidebar.endpoints[1].credentialDraft, '')
})
