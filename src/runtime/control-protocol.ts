export const CONTROL_PROTOCOL_VERSION = 1

export type ControlRequestMethod =
  | 'turn.cancel'
  | 'session.steer'
  | 'session.inject'
  | 'session.setApprovalPolicy'
  | 'session.setSandboxMode'
  | 'capabilities.get'
  | 'approval.resolve'

export const CONTROL_CAPABILITIES = [
  'turn.cancel',
  'session.steer',
  'session.inject',
  'session.setApprovalPolicy',
  'session.setSandboxMode',
  'capabilities.get',
  'approval.resolve',
] as const satisfies readonly ControlRequestMethod[]

export function isControlRequestMethod(value: unknown): value is ControlRequestMethod {
  return typeof value === 'string' && CONTROL_CAPABILITIES.includes(value as ControlRequestMethod)
}

export type ControlApprovalOutcome = 'allowed-once' | 'rejected'
export type ControlApprovalResult = ControlApprovalOutcome | 'cancelled' | 'unavailable'
export type ControlSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface ControlRequestEnvelope {
  version: typeof CONTROL_PROTOCOL_VERSION
  type: 'request'
  requestId: string
  sessionId: string
  method: ControlRequestMethod
  params: Record<string, unknown>
}

export interface ControlResponseEnvelope {
  version: typeof CONTROL_PROTOCOL_VERSION
  type: 'response'
  requestId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export interface ControlHelloEnvelope {
  version: typeof CONTROL_PROTOCOL_VERSION
  type: 'hello'
  token: string
  capabilities?: readonly ControlRequestMethod[]
}

export interface ControlHelloAckEnvelope {
  version: typeof CONTROL_PROTOCOL_VERSION
  type: 'helloAck'
  capabilities: readonly ControlRequestMethod[]
}

export interface ControlEventEnvelope {
  version: typeof CONTROL_PROTOCOL_VERSION
  type: 'event'
  eventId: string
  sessionId: string
  method: 'approval.request' | 'approval.resolved'
  params: Record<string, unknown>
}

export type ControlEnvelope =
  | ControlRequestEnvelope
  | ControlResponseEnvelope
  | ControlHelloEnvelope
  | ControlHelloAckEnvelope
  | ControlEventEnvelope

export function encodeControlEnvelope(envelope: ControlEnvelope): string {
  return `${JSON.stringify(envelope)}\n`
}

export function parseControlLine(line: string): ControlEnvelope | undefined {
  if (!line.trim()) return undefined

  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }

  if (!isRecord(value) || value.version !== CONTROL_PROTOCOL_VERSION || typeof value.type !== 'string') {
    return undefined
  }

  return value as unknown as ControlEnvelope
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
