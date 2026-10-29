import { randomUUID } from 'node:crypto'
import { stringValue } from '../shared/value-utils.js'
import type { ControlRequestEnvelope } from './control-protocol.js'

export type PluginErrorCode = 'SESSION_NOT_FOUND' | 'SESSION_NOT_OWNED' | 'APPROVAL_NOT_PENDING' | 'INVALID_ARGUMENT' | 'CONTROL_REQUEST_FAILED'

export class PluginControlError extends Error {
  constructor(message: string, readonly code: PluginErrorCode) {
    super(message)
  }
}

/**
 * Session authority checks, shared by every bridge so an agent can never be
 * driven through the session of a parent it does not own.
 */
export function getAgent(ctx: any, sessionId: string): any | undefined {
  const agents = ctx.get?.('agents') ?? ctx.agents
  return agents?.get?.(sessionId)
}

export function isOwnedBy(ctx: any, agent: any, authoritySessionId: string): boolean {
  const visited = new Set<string>()
  let current: any = agent
  while (current?.id && !visited.has(current.id)) {
    if (current.id === authoritySessionId) return true
    visited.add(current.id)
    const parentSessionId = current.session?.header?.parentSession
    if (typeof parentSessionId !== 'string') return false
    current = getAgent(ctx, parentSessionId)
  }
  return false
}

export function authorityOf(request: ControlRequestEnvelope): string {
  return stringValue(request.params.authoritySessionId) ?? request.sessionId
}

export function requireAgent(ctx: any, request: ControlRequestEnvelope, notFound?: string): any {
  const agent = getAgent(ctx, request.sessionId)
  if (agent === undefined) throw new PluginControlError(notFound ?? `Session ${request.sessionId} is not active.`, 'SESSION_NOT_FOUND')
  const authoritySessionId = authorityOf(request)
  if (!isOwnedBy(ctx, agent, authoritySessionId)) {
    throw new PluginControlError(`Session ${request.sessionId} is not owned by ${authoritySessionId}.`, 'SESSION_NOT_OWNED')
  }
  return agent
}

/** A user-originated message in the runtime's own wire format. */
export function createUserMessage(text: string): Record<string, unknown> {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

export function requiredString(value: unknown, name: string): string {
  const result = stringValue(value)
  if (result === undefined) throw new PluginControlError(`${name} is required.`, 'INVALID_ARGUMENT')
  return result
}
