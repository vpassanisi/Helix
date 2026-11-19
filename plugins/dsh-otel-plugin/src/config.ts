import Schema from '@deepseek-ai/schemastery'

const ProtocolSchema = Schema.union([
  Schema.const('http/protobuf'),
  Schema.const('grpc'),
])

const MessagesModeSchema = Schema.union([
  Schema.const('full'),
  Schema.const('refs'),
  Schema.const('objects'),
  Schema.const('checkpoint'),
  Schema.const('omit'),
])

const RefEncodingSchema = Schema.union([Schema.const('base64url'), Schema.const('hex')])

/** Layer-2 resync trigger names. `sessionStart` and the Layer-1 structural checks are implicit. */
export const RESYNC_TRIGGERS = [
  'userMessage',
  'promptSections',
  'toolSet',
  'route',
  'compaction',
  'feedback',
  'splice',
  'seed',
  'surfaceReplace',
  'runtimeContext',
  'turnRoot',
  'exportGap',
  'unknownEvent',
] as const

export type ResyncTrigger = (typeof RESYNC_TRIGGERS)[number]

const ResyncTriggerSchema = Schema.union(RESYNC_TRIGGERS.map(name => Schema.const(name)))


const EndpointSchema = Schema.object({
  /** HTTP requires a complete traces URL. gRPC accepts a target such as host:4317 or unix:///path. */
  url: Schema.string().default(''),
  protocol: ProtocolSchema.default('http/protobuf'),
  /** Header values sent to this destination as HTTP headers or gRPC metadata. */
  headers: Schema.dict(Schema.string()).default({}),
  timeoutMs: Schema.natural().min(100).max(120_000).default(5_000),
})

export const ConfigSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  serviceName: Schema.string().default('dsh'),
  endpoints: Schema.array(EndpointSchema).default([]),
  capturePrompts: Schema.boolean().default(false),
  captureResponses: Schema.boolean().default(false),
  captureToolArguments: Schema.boolean().default(false),
  maxContentLength: Schema.natural().min(64).max(65_536).default(8_192),
  /** Shape of `gen_ai.input.messages`. `full` reproduces the shipped behaviour exactly. */
  inputMessagesMode: MessagesModeSchema.default('full'),
  /**
   * Chat spans without a checkpoint before a span carries the full ordered ref list again.
   * Counted across the conversation, not per trace. 0 checkpoints only at session start.
   */
  maxSpansBetweenResyncs: Schema.natural().max(100_000).default(16),
  /**
   * Layer-2 events that force a checkpoint. The default keeps only the repairs the
   * structural Layer-1 prefix check cannot make on its own; the full list restores a
   * checkpoint at every turn.
   */
  resyncOn: Schema.array(ResyncTriggerSchema).default([
    'exportGap',
    'unknownEvent',
  ]),
  /** Hex characters of the truncated SHA-256 ref. 12 is 48 bits. */
  refHashLength: Schema.natural().min(8).max(16).default(12),
  refEncoding: RefEncodingSchema.default('base64url'),
  /** Per-entry cap applied before hashing, so a ref names exactly the published bytes. */
  messageEntryMaxBytes: Schema.natural().min(64).max(65_536).default(8_192),
  /**
   * Conversation watermark entries kept in memory. The watermark spans the conversation,
   * so this bounds its growth. The least recently named entry is evicted, and an evicted
   * ref republishes at its next namer: the recovery window for payloads a backend has expired.
   */
  watermarkMaxEntries: Schema.natural().min(64).max(65_536).default(4_096),
  captureSystemPromptSections: Schema.boolean().default(true),
  /** Emit session-log pointers (`dsh.surface_seq_*`) so a log-connected resolver can repair. */
  contextPointers: Schema.boolean().default(true),
  exportGapResyncs: Schema.boolean().default(true),
})

export type TracingConfig = Schemastery.TypeT<typeof ConfigSchema>
export type OtlpProtocol = 'http/protobuf' | 'grpc'
export type InputMessagesMode = 'full' | 'refs' | 'objects' | 'checkpoint' | 'omit'
export type RefEncoding = 'base64url' | 'hex'
export type EndpointConfig = Schemastery.TypeT<typeof EndpointSchema>
export type EndpointInput = Partial<EndpointConfig>
export type TracingConfigInput = Partial<Omit<TracingConfig, 'endpoints' | 'resyncOn'>> & {
  endpoints?: EndpointInput[]
  resyncOn?: ResyncTrigger[]
}

export interface ResolvedEndpoint {
  url: string
  protocol: OtlpProtocol
  headers?: Record<string, string>
  timeoutMs: number
}

export interface ResolvedConfig {
  enabled: boolean
  serviceName: string
  endpoints: ResolvedEndpoint[]
  capturePrompts: boolean
  captureResponses: boolean
  captureToolArguments: boolean
  maxContentLength: number
  inputMessagesMode: InputMessagesMode
  maxSpansBetweenResyncs: number
  resyncOn: ResyncTrigger[]
  refHashLength: number
  refEncoding: RefEncoding
  messageEntryMaxBytes: number
  watermarkMaxEntries: number
  captureSystemPromptSections: boolean
  contextPointers: boolean
  exportGapResyncs: boolean
}

export type Environment = Record<string, string | undefined>

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values.find(value => value !== undefined && value.trim() !== '')?.trim()
}

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function resolveHeaders(headers: Record<string, string> | undefined, endpointIndex: number): Record<string, string> | undefined {
  const entries = Object.entries(headers ?? {})
  if (entries.length === 0) return undefined

  const normalized: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const [rawName, value] of entries) {
    const name = rawName.trim()
    const normalizedName = name.toLowerCase()
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`OTLP destination ${endpointIndex + 1} has an invalid header name.`)
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`OTLP destination ${endpointIndex + 1} has an invalid header value.`)
    }
    if (seen.has(normalizedName)) {
      throw new Error(`OTLP destination ${endpointIndex + 1} has duplicate header names.`)
    }
    seen.add(normalizedName)
    normalized.push([normalizedName, value])
  }
  return Object.fromEntries(normalized)
}

function validateHttpEndpoint(endpoint: string): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error(`Invalid OTLP HTTP endpoint URL: ${endpoint}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OTLP HTTP/protobuf endpoint must use http or https')
  }
  return parsed.toString().replace(/\/$/, '')
}

function validateGrpcTarget(target: string): string {
  const value = target.trim()
  if (!value) throw new Error('OTLP gRPC endpoint target cannot be empty')
  if (value.startsWith('unix://')) {
    try {
      const parsed = new URL(value)
      if (!parsed.pathname) throw new Error()
    } catch {
      throw new Error(`Invalid OTLP gRPC endpoint target: ${target}`)
    }
    return value
  }

  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    throw new Error(`Invalid OTLP gRPC endpoint target: ${target}`)
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host) {
    throw new Error(`Invalid OTLP gRPC endpoint target: ${target}`)
  }
  return value
}

function resolveEndpoint(endpoint: EndpointInput, index: number, env: Environment): ResolvedEndpoint {
  const protocol = endpoint.protocol ?? 'http/protobuf'
  const configuredUrl = endpoint.url ?? ''
  const url = protocol === 'grpc'
    ? validateGrpcTarget(configuredUrl)
    : validateHttpEndpoint(configuredUrl)
  const timeoutMs = endpoint.timeoutMs ?? 5_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error(`Endpoint ${index + 1} timeoutMs must be an integer from 100 to 120000`)
  }

  return {
    url,
    protocol,
    headers: resolveHeaders(endpoint.headers, index),
    timeoutMs,
  }
}

export function resolveConfig(config: TracingConfigInput, env: Environment = process.env): ResolvedConfig {
  const refHashLength = config.refHashLength ?? 12
  if (!Number.isInteger(refHashLength) || refHashLength < 8 || refHashLength > 16) {
    throw new Error('refHashLength must be an integer from 8 to 16')
  }
  const messageEntryMaxBytes = config.messageEntryMaxBytes ?? 8_192
  if (!Number.isInteger(messageEntryMaxBytes) || messageEntryMaxBytes < 64 || messageEntryMaxBytes > 65_536) {
    throw new Error('messageEntryMaxBytes must be an integer from 64 to 65536')
  }
  const resyncOn = config.resyncOn ?? ['exportGap', 'unknownEvent']
  const unknown = resyncOn.filter(name => !(RESYNC_TRIGGERS as readonly string[]).includes(name))
  if (unknown.length > 0) throw new Error(`Unknown resyncOn trigger: ${unknown.join(', ')}`)
  const watermarkMaxEntries = config.watermarkMaxEntries ?? 4_096
  if (!Number.isInteger(watermarkMaxEntries) || watermarkMaxEntries < 64 || watermarkMaxEntries > 65_536) {
    throw new Error('watermarkMaxEntries must be an integer from 64 to 65536')
  }

  return {
    enabled: config.enabled ?? false,
    serviceName: firstValue(env.OTEL_SERVICE_NAME, config.serviceName, 'dsh')!,
    endpoints: (config.endpoints ?? []).map((endpoint, index) => resolveEndpoint(endpoint, index, env)),
    capturePrompts: config.capturePrompts ?? false,
    captureResponses: config.captureResponses ?? false,
    captureToolArguments: config.captureToolArguments ?? false,
    maxContentLength: config.maxContentLength ?? 8_192,
    inputMessagesMode: config.inputMessagesMode ?? 'full',
    maxSpansBetweenResyncs: config.maxSpansBetweenResyncs ?? 16,
    resyncOn,
    refHashLength,
    refEncoding: config.refEncoding ?? 'base64url',
    messageEntryMaxBytes,
    watermarkMaxEntries,
    captureSystemPromptSections: config.captureSystemPromptSections ?? true,
    contextPointers: config.contextPointers ?? true,
    exportGapResyncs: config.exportGapResyncs ?? true,
  }
}
