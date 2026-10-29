import * as vscode from 'vscode'
import {
  isValidOtelEndpointId,
  isValidOtelHeaderName,
  normalizeOtelTracingSettings,
  type OtelTracingSettings,
} from '../shared/otel-tracing.js'
import { validateHttpUrl } from './mcp-settings.js'

const OTEL_SECRET_PREFIX = 'deepseekHarness.otelTracing.endpoint.'

export function otelEndpointSecretKey(id: string): string {
  return `${OTEL_SECRET_PREFIX}${id}.credential`
}

/**
 * Pre-secret-store destinations stored their headers in an environment
 * variable of comma-separated key=value pairs.
 */
export function resolveLegacyHeaders(environmentName: string | undefined): Record<string, string> {
  const name = environmentName?.trim()
  if (!name) return {}
  const raw = process.env[name]?.trim()
  if (!raw) throw new Error(`Environment variable ${name} is required for the existing OTLP destination.`)
  const headers: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const separator = pair.indexOf('=')
    if (separator <= 0) throw new Error(`Invalid headers in environment variable ${name}; expected comma-separated key=value pairs.`)
    const headerName = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!isValidOtelHeaderName(headerName) || /[\r\n]/.test(value)) {
      throw new Error(`Invalid header in environment variable ${name}.`)
    }
    headers[headerName] = value
  }
  return headers
}

export function tracingCredentialHeaders(endpoint: OtelTracingSettings['endpoints'][number], credential: string | undefined): Record<string, string> {
  if (!credential) return {}
  if (credential.includes('\r') || credential.includes('\n')) {
    throw new Error(`OTLP destination credential for ${endpoint.url} contains a line break.`)
  }
  return endpoint.authMethod === 'bearer'
    ? { authorization: `Bearer ${credential}` }
    : { [endpoint.headerName.trim() || 'x-api-key']: credential }
}

export async function validateTracingSecrets(tracing: OtelTracingSettings, secrets: vscode.SecretStorage): Promise<void> {
  if (!tracing.enabled) return
  for (const [index, endpoint] of tracing.endpoints.entries()) {
    if (endpoint.authMethod === 'none') continue
    if (endpoint.clearCredential && !endpoint.credentialDraft.trim()) {
      throw new Error(`OTLP destination ${index + 1} needs a credential for its selected authentication method.`)
    }
    if (endpoint.credentialDraft.trim()) continue
    const saved = await secrets.get(otelEndpointSecretKey(endpoint.id))
    if (saved === undefined) {
      throw new Error(`Enter a credential for OTLP destination ${index + 1}, or choose no authentication.`)
    }
  }
}

/**
 * Reconciles stored OTLP credentials with the submitted endpoints: clears
 * credentials whose endpoint disappeared or switched to no authentication,
 * and stores newly typed ones.
 */
export async function syncTracingSecrets(tracing: OtelTracingSettings, secrets: vscode.SecretStorage): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('deepseekHarness')
  const previous = normalizeOtelTracingSettings(configuration.get<unknown>('otelTracing', {}))
  const nextById = new Map(tracing.endpoints.map((endpoint) => [endpoint.id, endpoint]))
  const deletedCredentials = new Set<string>()
  for (const endpoint of previous.endpoints) {
    const next = nextById.get(endpoint.id)
    if ((next === undefined || next.authMethod === 'none') && endpoint.authMethod !== 'none') {
      await secrets.delete(otelEndpointSecretKey(endpoint.id))
      deletedCredentials.add(endpoint.id)
    }
  }
  for (const endpoint of tracing.endpoints) {
    const key = otelEndpointSecretKey(endpoint.id)
    if (endpoint.authMethod === 'none' || endpoint.clearCredential) {
      if ((endpoint.credentialConfigured || endpoint.clearCredential) && !deletedCredentials.has(endpoint.id)) {
        await secrets.delete(key)
      }
    } else if (endpoint.credentialDraft.trim()) {
      await secrets.store(key, endpoint.credentialDraft.trim())
    }
  }
}

/** The tracing configuration the runtime starts with, secrets resolved. */
export async function buildRuntimeTracingConfig(secrets: vscode.SecretStorage): Promise<Record<string, unknown>> {
  const configuration = vscode.workspace.getConfiguration('deepseekHarness')
  const tracing = normalizeOtelTracingSettings(configuration.get<unknown>('otelTracing', {}))
  const endpoints = await Promise.all(tracing.endpoints
    .filter((endpoint) => endpoint.url.trim())
    .map(async (endpoint) => {
      const headers = endpoint.authMethod === 'bearer' || endpoint.authMethod === 'api-key'
        ? tracingCredentialHeaders(endpoint, await secrets.get(otelEndpointSecretKey(endpoint.id)))
        : resolveLegacyHeaders(endpoint.legacyHeadersEnv)
      return {
        url: endpoint.url.trim(),
        protocol: endpoint.protocol,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        timeoutMs: endpoint.timeoutMs,
      }
    }))
  return {
    enabled: tracing.enabled,
    serviceName: tracing.serviceName.trim() || 'helix',
    endpoints,
    capturePrompts: tracing.capturePrompts,
    captureResponses: tracing.captureResponses,
    captureToolArguments: tracing.captureToolArguments,
    maxContentLength: tracing.maxContentLength,
  }
}

/** The tracing settings the sidebar shows: credentials hidden behind flags. */
export async function buildSidebarTracingSettings(secrets: vscode.SecretStorage): Promise<OtelTracingSettings> {
  const configuration = vscode.workspace.getConfiguration('deepseekHarness')
  const tracing = normalizeOtelTracingSettings(configuration.get<unknown>('otelTracing', {}))
  return {
    ...tracing,
    endpoints: await Promise.all(tracing.endpoints.map(async (endpoint) => ({
      ...endpoint,
      credentialConfigured: (await secrets.get(otelEndpointSecretKey(endpoint.id))) !== undefined,
      credentialDraft: '',
      clearCredential: false,
    }))),
  }
}

export function validateTracingEndpoints(tracing: OtelTracingSettings): void {
  const endpointIds = new Set<string>()
  for (const [index, endpoint] of tracing.endpoints.entries()) {
    if (!isValidOtelEndpointId(endpoint.id)) throw new Error(`OTLP destination ${index + 1} has an invalid ID.`)
    if (endpointIds.has(endpoint.id)) throw new Error(`OTLP destination ${index + 1} has a duplicate ID.`)
    endpointIds.add(endpoint.id)
    if (endpoint.authMethod === 'api-key' && !isValidOtelHeaderName(endpoint.headerName.trim())) {
      throw new Error(`OTLP destination ${index + 1} needs a valid API key header name.`)
    }
    if (endpoint.credentialDraft.includes('\r') || endpoint.credentialDraft.includes('\n')) {
      throw new Error(`OTLP destination ${index + 1} credential cannot contain a line break.`)
    }
    const value = endpoint.url.trim()
    if (!value) {
      if (tracing.enabled) throw new Error(`OTLP destination ${index + 1} needs an endpoint.`)
      continue
    }
    if (endpoint.protocol === 'grpc') {
      validateGrpcTarget(value, index)
    } else {
      validateHttpUrl(value, `OTLP destination ${index + 1}`)
    }
    if (!Number.isInteger(endpoint.timeoutMs) || endpoint.timeoutMs < 100 || endpoint.timeoutMs > 120_000) {
      throw new Error(`OTLP destination ${index + 1} timeout must be between 100 and 120000 milliseconds.`)
    }
  }
}

export function validateGrpcTarget(value: string, index: number): void {
  if (value.startsWith('unix://')) {
    try {
      const parsed = new URL(value)
      if (!parsed.pathname) throw new Error()
    } catch {
      throw new Error(`OTLP destination ${index + 1} needs a valid gRPC target.`)
    }
    return
  }

  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    throw new Error(`OTLP destination ${index + 1} needs a valid gRPC target.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OTLP destination ${index + 1} needs a valid gRPC target.`)
  }
}
