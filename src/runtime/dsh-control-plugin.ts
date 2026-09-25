import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_CAPABILITIES,
  encodeControlEnvelope,
  parseControlLine,
  type ControlApprovalResult,
  type ControlEnvelope,
  type ControlRequestEnvelope,
  type ControlSandboxMode,
} from './control-protocol.js'
import { stringValue } from '../shared/value-utils.js'

interface PendingApproval {
  sessionId: string
  resolve: (outcome: ControlApprovalResult) => void
  signal?: AbortSignal
  abortListener?: () => void
  settled: boolean
}

const APPROVAL_POLICIES = new Set(['ask', 'never'])
const SANDBOX_MODES = new Set<ControlSandboxMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
])

type PluginErrorCode = 'SESSION_NOT_FOUND' | 'SESSION_NOT_OWNED' | 'APPROVAL_NOT_PENDING' | 'INVALID_ARGUMENT' | 'CONTROL_REQUEST_FAILED'

class PluginControlError extends Error {
  constructor(message: string, readonly code: PluginErrorCode) {
    super(message)
  }
}

/**
 * DSH-side control adapter. It intentionally uses only the runtime services
 * exposed on the Cordis context so the compiled plugin can travel with the
 * extension without shipping a second DSH dependency tree.
 */
export default function helixControlPlugin(ctx: any): void {
  const endpoint = process.env.HELIX_CONTROL_ENDPOINT
  const token = process.env.HELIX_CONTROL_TOKEN
  if (!endpoint || !token) return

  let socket: Socket | undefined
  let socketBuffer = ''
  let connected = false
  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempt = 0
  const approvals = new Map<string, PendingApproval>()

  const send = (envelope: ControlEnvelope): boolean => {
    if (!connected || socket === undefined || socket.destroyed) return false
    try {
      socket.write(encodeControlEnvelope(envelope))
      return true
    } catch {
      return false
    }
  }

  const sendResponse = (
    request: ControlRequestEnvelope,
    result?: unknown,
    error?: { code: string; message: string },
  ): void => {
    send({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'response',
      requestId: request.requestId,
      ok: error === undefined,
      ...(error === undefined ? { result } : { error }),
    })
  }

  const sendEvent = (
    sessionId: string,
    method: 'approval.request' | 'approval.resolved' | 'assistant.stream',
    params: Record<string, unknown>,
  ): boolean => send({
    version: CONTROL_PROTOCOL_VERSION,
    type: 'event',
    eventId: randomUUID(),
    sessionId,
    method,
    params,
  })

  const finishApproval = (
    approvalId: string,
    pending: PendingApproval,
    outcome: ControlApprovalResult,
  ): boolean => {
    if (pending.settled) return false
    pending.settled = true
    approvals.delete(approvalId)
    removeAbortListener(pending)
    pending.resolve(outcome)
    void sendEvent(pending.sessionId, 'approval.resolved', { approvalId, outcome })
    return true
  }

  const getAgent = (sessionId: string): any | undefined => {
    const agents = ctx.get?.('agents') ?? ctx.agents
    return agents?.get?.(sessionId)
  }

  const isOwnedBy = (agent: any, authoritySessionId: string): boolean => {
    const visited = new Set<string>()
    let current: any = agent
    while (current?.id && !visited.has(current.id)) {
      if (current.id === authoritySessionId) return true
      visited.add(current.id)
      const parentSessionId = current.session?.header?.parentSession
      if (typeof parentSessionId !== 'string') return false
      current = getAgent(parentSessionId)
    }
    return false
  }

  const requireAgent = (request: ControlRequestEnvelope): any => {
    const agent = getAgent(request.sessionId)
    if (agent === undefined) throw new PluginControlError(`Session ${request.sessionId} is not active.`, 'SESSION_NOT_FOUND')
    const authoritySessionId = stringValue(request.params.authoritySessionId) ?? request.sessionId
    if (!isOwnedBy(agent, authoritySessionId)) {
      throw new PluginControlError(`Session ${request.sessionId} is not owned by ${authoritySessionId}.`, 'SESSION_NOT_OWNED')
    }
    return agent
  }

  const createUserMessage = (text: string): Record<string, unknown> => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })

  const handleCapabilities = (request: ControlRequestEnvelope): void => {
    sendResponse(request, { version: CONTROL_PROTOCOL_VERSION, capabilities: CONTROL_CAPABILITIES })
  }

  const handleApprovalResolution = (request: ControlRequestEnvelope): void => {
    const approvalId = stringValue(request.params.approvalId)
    const pending = approvalId === undefined ? undefined : approvals.get(approvalId)
    if (approvalId === undefined || pending === undefined || pending.sessionId !== request.sessionId) {
      throw new PluginControlError('Approval request is no longer pending.', 'APPROVAL_NOT_PENDING')
    }
    const outcome = request.params.outcome
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      throw new PluginControlError('Approval outcome must be allowed-once or rejected.', 'INVALID_ARGUMENT')
    }
    if (!finishApproval(approvalId, pending, outcome)) {
      throw new PluginControlError('Approval request is no longer pending.', 'APPROVAL_NOT_PENDING')
    }
    sendResponse(request, { accepted: true })
  }

  const handleAgentRequest = (request: ControlRequestEnvelope): void => {
    const agent = requireAgent(request)
    switch (request.method) {
      case 'turn.cancel':
        agent.cancel({ kind: 'user' }, { keepInbox: false })
        sendResponse(request, { accepted: true, status: agent.status })
        return
      case 'session.steer':
        agent.steer(createUserMessage(requiredString(request.params.text, 'text')))
        sendResponse(request, { accepted: true })
        return
      case 'session.inject':
        agent.inject(createUserMessage(requiredString(request.params.text, 'text')))
        sendResponse(request, { accepted: true })
        return
      case 'session.setApprovalPolicy': {
        const policy = requiredString(request.params.policy, 'policy')
        if (!APPROVAL_POLICIES.has(policy)) throw new PluginControlError('Approval policy must be ask or never.', 'INVALID_ARGUMENT')
        const approval = ctx.get?.('approval') ?? ctx.approval
        if (approval?.setPolicy === undefined) throw new PluginControlError('Approval policy control is unavailable.', 'CONTROL_REQUEST_FAILED')
        approval.setPolicy(agent, policy)
        sendResponse(request, { accepted: true, policy })
        return
      }
      case 'session.setSandboxMode': {
        const mode = requiredString(request.params.mode, 'mode') as ControlSandboxMode
        if (!SANDBOX_MODES.has(mode)) throw new PluginControlError('Sandbox mode is invalid.', 'INVALID_ARGUMENT')
        agent.session.append('sandbox/mode', { mode })
        sendResponse(request, { accepted: true, mode })
        return
      }
      default:
        throw new PluginControlError(`Unsupported control method ${request.method}.`, 'CONTROL_REQUEST_FAILED')
    }
  }

  const handleRequest = async (request: ControlRequestEnvelope): Promise<void> => {
    try {
      if (request.method === 'capabilities.get') return handleCapabilities(request)
      if (request.method === 'approval.resolve') return handleApprovalResolution(request)
      handleAgentRequest(request)
    } catch (error) {
      sendResponse(request, undefined, {
        code: error instanceof PluginControlError ? error.code : 'CONTROL_REQUEST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleEnvelope = (envelope: ControlEnvelope): void => {
    if (envelope.type === 'helloAck') {
      connected = true
      reconnectAttempt = 0
      return
    }
    if (envelope.type === 'request') void handleRequest(envelope)
  }

  const scheduleReconnect = (): void => {
    if (disposed || reconnectTimer !== undefined || reconnectAttempt >= 5) return
    const delays = [100, 250, 500, 1_000, 1_000]
    const delay = delays[reconnectAttempt] ?? 1_000
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  const connect = (): void => {
    if (disposed) return
    const client = createConnection(endpoint)
    socket = client
    socketBuffer = ''
    client.setEncoding('utf8')
    client.on('connect', () => {
      client.write(encodeControlEnvelope({
        version: CONTROL_PROTOCOL_VERSION,
        type: 'hello',
        token,
        capabilities: CONTROL_CAPABILITIES,
      }))
    })
    client.on('data', (chunk: string) => {
      socketBuffer += chunk
      let newlineIndex = socketBuffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = socketBuffer.slice(0, newlineIndex)
        socketBuffer = socketBuffer.slice(newlineIndex + 1)
        const envelope = parseControlLine(line)
        if (envelope !== undefined) handleEnvelope(envelope)
        newlineIndex = socketBuffer.indexOf('\n')
      }
    })
    client.on('error', () => {
      connected = false
    })
    client.on('close', () => {
      if (socket !== client) return
      connected = false
      socket = undefined
      for (const [approvalId, pending] of approvals) {
        finishApproval(approvalId, pending, 'unavailable')
      }
      scheduleReconnect()
    })
  }

  const onApprovalRequest = async (request: any, next: () => Promise<ControlApprovalResult>): Promise<ControlApprovalResult> => {
    if (!connected || socket === undefined) return next()

    const sessionId = stringValue(request.agent?.id)
    if (sessionId === undefined) return next()

    const approvalId = randomUUID()
    let pending: PendingApproval | undefined
    const outcome = new Promise<ControlApprovalResult>((resolve) => {
      pending = { sessionId, resolve, signal: request.signal, settled: false }
      approvals.set(approvalId, pending)
    })

    const current = pending
    if (current === undefined) return next()
    if (request.signal?.aborted) {
      finishApproval(approvalId, current, 'cancelled')
      return 'cancelled'
    } else if (request.signal !== undefined) {
      const abortListener = () => {
        finishApproval(approvalId, current, 'cancelled')
      }
      current.abortListener = abortListener
      request.signal.addEventListener('abort', abortListener, { once: true })
    }

    const sent = sendEvent(sessionId, 'approval.request', {
      approvalId,
      toolName: stringValue(request.toolName) ?? 'Tool call',
      ...(stringValue(request.callId) ? { toolCallId: String(request.callId) } : {}),
      ...(stringValue(request.reason) ? { reason: String(request.reason) } : {}),
    })
    if (!sent) {
      approvals.delete(approvalId)
      removeAbortListener(current)
      return next()
    }

    return outcome
  }

  const onAssistantStream = (payload: any): void => {
    const sessionId = stringValue(payload?.agent?.id)
    const frame = payload?.frame
    if (sessionId === undefined || frame === undefined || typeof frame !== 'object' || frame === null) return
    sendEvent(sessionId, 'assistant.stream', { frame })
  }

  try {
    ctx.on?.('approval/request', onApprovalRequest, { global: true })
    ctx.on?.('agent/assistant-stream', onAssistantStream, { global: true })
    ctx.effect?.(() => () => {
      disposed = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      connected = false
      socket?.destroy()
      socket = undefined
      for (const [approvalId, pending] of approvals) {
        finishApproval(approvalId, pending, 'cancelled')
      }
    }, 'helix-control-bridge.lifecycle')
  } catch (error) {
    if (!isInactiveContextError(error)) throw error
    return
  }

  connect()
}

function removeAbortListener(pending: PendingApproval): void {
  if (pending.signal !== undefined && pending.abortListener !== undefined) {
    pending.signal.removeEventListener('abort', pending.abortListener)
  }
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value)
  if (result === undefined) throw new PluginControlError(`${name} is required.`, 'INVALID_ARGUMENT')
  return result
}

function isInactiveContextError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === 'cannot create effect on inactive context' ||
    (error as { code?: unknown }).code === 'INACTIVE_EFFECT'
  )
}
