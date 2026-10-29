import { randomUUID } from 'node:crypto'
import { stringValue } from '../shared/value-utils.js'
import type { ControlApprovalResult, ControlRequestEnvelope } from './control-protocol.js'
import { PluginControlError } from './dsh-control-shared.js'

interface PendingApproval {
  sessionId: string
  resolve: (outcome: ControlApprovalResult) => void
  signal?: AbortSignal
  abortListener?: () => void
  settled: boolean
}

/**
 * The approval/request seam: a tool call that needs permission waits here
 * until the extension host resolves the matching approval, the turn is
 * aborted, or the control channel drops.
 */
export class DshApprovalBridge {
  private readonly approvals = new Map<string, PendingApproval>()

  constructor(
    private readonly isAvailable: () => boolean,
    private readonly emit: (sessionId: string, method: 'approval.request' | 'approval.resolved', params: Record<string, unknown>) => boolean,
  ) {}

  request = async (request: any, next: () => Promise<ControlApprovalResult>): Promise<ControlApprovalResult> => {
    const sessionId = stringValue(request?.agent?.id)
    if (sessionId === undefined) return next()
    if (!this.isAvailable()) return next()

    const approvalId = randomUUID()
    let pending: PendingApproval | undefined
    const outcome = new Promise<ControlApprovalResult>((resolve) => {
      pending = { sessionId, resolve, signal: request.signal, settled: false }
      this.approvals.set(approvalId, pending)
    })

    const current = pending
    if (current === undefined) return next()
    if (request.signal?.aborted) {
      this.finish(approvalId, current, 'cancelled')
      return 'cancelled'
    } else if (request.signal !== undefined) {
      const abortListener = () => {
        this.finish(approvalId, current, 'cancelled')
      }
      current.abortListener = abortListener
      request.signal.addEventListener('abort', abortListener, { once: true })
    }

    const sent = this.emit(sessionId, 'approval.request', {
      approvalId,
      toolName: stringValue(request.toolName) ?? 'Tool call',
      ...(stringValue(request.callId) ? { toolCallId: String(request.callId) } : {}),
      ...(stringValue(request.reason) ? { reason: String(request.reason) } : {}),
    })
    if (!sent) {
      this.approvals.delete(approvalId)
      this.removeAbortListener(current)
      return next()
    }

    return outcome
  }

  /** Throws when the approval is not pending; the caller sends the error response. */
  resolve(request: ControlRequestEnvelope): void {
    const approvalId = stringValue(request.params.approvalId)
    const pending = approvalId === undefined ? undefined : this.approvals.get(approvalId)
    if (approvalId === undefined || pending === undefined || pending.sessionId !== request.sessionId) {
      throw new PluginControlError('Approval request is no longer pending.', 'APPROVAL_NOT_PENDING')
    }
    const outcome = request.params.outcome
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      throw new PluginControlError('Approval outcome must be allowed-once or rejected.', 'INVALID_ARGUMENT')
    }
    if (!this.finish(approvalId, pending, outcome)) {
      throw new PluginControlError('Approval request is no longer pending.', 'APPROVAL_NOT_PENDING')
    }
  }

  /** The channel went away: the UI cannot answer, so the turn cannot proceed. */
  closeUnavailable(): void {
    for (const [approvalId, pending] of this.approvals) this.finish(approvalId, pending, 'unavailable')
  }

  /** The process is going away: settle so no promise outlives the plugin. */
  cancelAll(): void {
    for (const [approvalId, pending] of this.approvals) this.finish(approvalId, pending, 'cancelled')
  }

  private finish(approvalId: string, pending: PendingApproval, outcome: ControlApprovalResult): boolean {
    if (pending.settled) return false
    pending.settled = true
    this.approvals.delete(approvalId)
    this.removeAbortListener(pending)
    pending.resolve(outcome)
    this.emit(pending.sessionId, 'approval.resolved', { approvalId, outcome })
    return true
  }

  private removeAbortListener(pending: PendingApproval): void {
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }
  }
}
