export type OtelTracingProtocol = 'http/protobuf' | 'grpc'
export type OtelTracingAuthMethod = 'none' | 'bearer' | 'api-key'

export interface OtelTracingEndpoint {
  id: string
  url: string
  protocol: OtelTracingProtocol
  authMethod: OtelTracingAuthMethod
  headerName: string
  timeoutMs: number
  credentialConfigured: boolean
  credentialDraft: string
  clearCredential: boolean
  /** Retained only to keep older environment based endpoint settings working until replaced. */
  legacyHeadersEnv?: string
}

export interface OtelTracingSettings {
  enabled: boolean
  serviceName: string
  endpoints: OtelTracingEndpoint[]
  capturePrompts: boolean
  captureResponses: boolean
  captureToolArguments: boolean
  maxContentLength: number
}

export const DEFAULT_OTEL_TRACING_ENDPOINT: OtelTracingEndpoint = {
  id: '',
  url: '',
  protocol: 'http/protobuf',
  authMethod: 'none',
  headerName: 'x-api-key',
  timeoutMs: 5000,
  credentialConfigured: false,
  credentialDraft: '',
  clearCredential: false,
}

export const DEFAULT_OTEL_TRACING_SETTINGS: OtelTracingSettings = {
  enabled: false,
  serviceName: 'helix',
  endpoints: [],
  capturePrompts: false,
  captureResponses: false,
  captureToolArguments: false,
  maxContentLength: 8192,
}

const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function isOtelTracingSettings(value: unknown): value is OtelTracingSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const settings = value as Record<string, unknown>
  return typeof settings.enabled === 'boolean' &&
    typeof settings.serviceName === 'string' &&
    Array.isArray(settings.endpoints) && settings.endpoints.every(isOtelTracingEndpoint) &&
    typeof settings.capturePrompts === 'boolean' &&
    typeof settings.captureResponses === 'boolean' &&
    typeof settings.captureToolArguments === 'boolean' &&
    Number.isInteger(settings.maxContentLength) && (settings.maxContentLength as number) >= 64 && (settings.maxContentLength as number) <= 65_536
}

export function normalizeOtelTracingSettings(value: unknown): OtelTracingSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_OTEL_TRACING_SETTINGS }
  const settings = value as Record<string, unknown>
  const endpoints = Array.isArray(settings.endpoints)
    ? settings.endpoints.map(normalizeEndpoint)
    : []

  // Migrate settings saved before endpoint fan-out was added.
  if (endpoints.length === 0 && typeof settings.endpoint === 'string' && settings.endpoint.trim()) {
    endpoints.push(normalizeEndpoint({
      url: settings.endpoint,
      protocol: settings.protocol === 'grpc' ? 'grpc' : 'http/protobuf',
      timeoutMs: validInteger(settings.exportTimeoutMs, 100, 120_000) ? settings.exportTimeoutMs : DEFAULT_OTEL_TRACING_ENDPOINT.timeoutMs,
    }, 0))
  }

  return {
    enabled: typeof settings.enabled === 'boolean' ? settings.enabled : DEFAULT_OTEL_TRACING_SETTINGS.enabled,
    serviceName: typeof settings.serviceName === 'string' ? settings.serviceName : DEFAULT_OTEL_TRACING_SETTINGS.serviceName,
    endpoints,
    capturePrompts: typeof settings.capturePrompts === 'boolean' ? settings.capturePrompts : DEFAULT_OTEL_TRACING_SETTINGS.capturePrompts,
    captureResponses: typeof settings.captureResponses === 'boolean' ? settings.captureResponses : DEFAULT_OTEL_TRACING_SETTINGS.captureResponses,
    captureToolArguments: typeof settings.captureToolArguments === 'boolean' ? settings.captureToolArguments : DEFAULT_OTEL_TRACING_SETTINGS.captureToolArguments,
    maxContentLength: validInteger(settings.maxContentLength, 64, 65_536) ? settings.maxContentLength : DEFAULT_OTEL_TRACING_SETTINGS.maxContentLength,
  }
}

/** Removes webview-only credential state before saving settings to VS Code configuration. */
export function persistedOtelTracingSettings(settings: OtelTracingSettings): Omit<OtelTracingSettings, 'endpoints'> & { endpoints: Array<Omit<OtelTracingEndpoint, 'credentialConfigured' | 'credentialDraft' | 'clearCredential'>> } {
  return {
    enabled: settings.enabled,
    serviceName: settings.serviceName,
    endpoints: settings.endpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url.trim(),
      protocol: endpoint.protocol,
      authMethod: endpoint.authMethod,
      headerName: endpoint.headerName.trim() || 'x-api-key',
      timeoutMs: endpoint.timeoutMs,
      ...(endpoint.authMethod === 'none' && endpoint.legacyHeadersEnv ? { legacyHeadersEnv: endpoint.legacyHeadersEnv } : {}),
    })),
    capturePrompts: settings.capturePrompts,
    captureResponses: settings.captureResponses,
    captureToolArguments: settings.captureToolArguments,
    maxContentLength: settings.maxContentLength,
  }
}

export function isValidOtelEndpointId(value: string): boolean {
  return ENDPOINT_ID_PATTERN.test(value)
}

export function isValidOtelHeaderName(value: string): boolean {
  return HEADER_NAME_PATTERN.test(value)
}

function isOtelTracingEndpoint(value: unknown): value is OtelTracingEndpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const endpoint = value as Record<string, unknown>
  return typeof endpoint.id === 'string' && isValidOtelEndpointId(endpoint.id) &&
    typeof endpoint.url === 'string' &&
    (endpoint.protocol === 'http/protobuf' || endpoint.protocol === 'grpc') &&
    (endpoint.authMethod === 'none' || endpoint.authMethod === 'bearer' || endpoint.authMethod === 'api-key') &&
    typeof endpoint.headerName === 'string' &&
    Number.isInteger(endpoint.timeoutMs) && (endpoint.timeoutMs as number) >= 100 && (endpoint.timeoutMs as number) <= 120_000 &&
    typeof endpoint.credentialConfigured === 'boolean' &&
    typeof endpoint.credentialDraft === 'string' &&
    typeof endpoint.clearCredential === 'boolean' &&
    (endpoint.legacyHeadersEnv === undefined || typeof endpoint.legacyHeadersEnv === 'string')
}

function normalizeEndpoint(value: unknown, index: number): OtelTracingEndpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_OTEL_TRACING_ENDPOINT, id: `legacy-${index}` }
  }
  const endpoint = value as Record<string, unknown>
  const candidateId = typeof endpoint.id === 'string' && isValidOtelEndpointId(endpoint.id) ? endpoint.id : `legacy-${index}`
  return {
    id: candidateId,
    url: typeof endpoint.url === 'string' ? endpoint.url : '',
    protocol: endpoint.protocol === 'grpc' ? 'grpc' : 'http/protobuf',
    authMethod: endpoint.authMethod === 'bearer' || endpoint.authMethod === 'api-key' ? endpoint.authMethod : 'none',
    headerName: typeof endpoint.headerName === 'string' ? endpoint.headerName : 'x-api-key',
    timeoutMs: validInteger(endpoint.timeoutMs, 100, 120_000) ? endpoint.timeoutMs : DEFAULT_OTEL_TRACING_ENDPOINT.timeoutMs,
    credentialConfigured: endpoint.credentialConfigured === true,
    credentialDraft: typeof endpoint.credentialDraft === 'string' ? endpoint.credentialDraft : '',
    clearCredential: endpoint.clearCredential === true,
    legacyHeadersEnv: typeof endpoint.legacyHeadersEnv === 'string'
      ? endpoint.legacyHeadersEnv
      : typeof endpoint.headersEnv === 'string' ? endpoint.headersEnv : undefined,
  }
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}
