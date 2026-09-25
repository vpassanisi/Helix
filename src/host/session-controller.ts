import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { captureEditorContext } from '../runtime/editor-context.js'
import { WorkspaceChangeTracker } from '../runtime/change-tracker.js'
import { ControlBridgeError, type ControlEvent } from '../runtime/control-bridge.js'
import { HarnessRuntime } from '../runtime/harness-runtime.js'
import { buildPromptContent } from '../runtime/prompt-context.js'
import { isControlApprovalResult } from '../runtime/control-protocol.js'
import type { RoutedNotification, RuntimeOptions, RuntimeState } from '../runtime/types.js'
import { SessionHierarchy } from '../runtime/session-hierarchy.js'
import { stringValue } from '../shared/value-utils.js'
import {
  SidebarProvider,
  type SidebarMessage,
  type SidebarOutgoingMessage,
} from '../sidebar/sidebar-provider.js'

const APPROVAL_LINEAGE_TIMEOUT_MS = 2_000

interface PendingApproval {
  rootSessionId: string
  agentSessionId: string
  toolCallId?: string
  toolName: string
  reason?: string
  state: 'pending' | 'resolving'
}

interface BufferedApproval {
  event: ControlEvent
  timer: ReturnType<typeof setTimeout>
}

export interface SessionControllerOptions {
  runtime: HarnessRuntime
  sidebar: SidebarProvider
  changeTracker: WorkspaceChangeTracker
  getRuntimeState: () => RuntimeState
  getRuntimeOptions: () => Promise<RuntimeOptions>
  getMaxSelectionCharacters: () => number
  onError: (error: unknown) => void
  onStateChanged: (resetTranscript?: boolean) => void
}

export class SessionController {
  private activeSessionId = randomUUID()
  private sessionRoute: { dispose(): void } | undefined
  private readonly sessionHierarchy = new SessionHierarchy()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly bufferedApprovals = new Map<string, BufferedApproval>()
  private promptGeneration = 0
  private disposed = false

  constructor(private readonly options: SessionControllerOptions) {
    this.registerSessionRoute(this.activeSessionId)
  }

  get currentSessionId(): string {
    return this.activeSessionId
  }

  async newSession(): Promise<void> {
    const previousSessionId = this.activeSessionId
    ++this.promptGeneration

    try {
      await this.options.runtime.cancelTurn(previousSessionId)
    } catch (error) {
      if (!isInactiveRuntimeError(error)) this.options.onError(error)
    }

    await this.rejectPendingApprovals()
    this.options.changeTracker.finish(previousSessionId)
    this.disposeRoute()
    this.sessionHierarchy.clear()

    this.activeSessionId = randomUUID()
    this.registerSessionRoute(this.activeSessionId)
    this.options.onStateChanged(true)
  }

  async submit(prompt: string, includeSelection: boolean): Promise<void> {
    const generation = ++this.promptGeneration
    const sessionId = this.activeSessionId
    const editor = includeSelection ? vscode.window.activeTextEditor : undefined
    const contentBlocks = buildPromptContent(
      prompt,
      captureEditorContext(editor),
      this.options.getMaxSelectionCharacters(),
    )

    try {
      if (this.options.getRuntimeState() !== 'ready') {
        await this.options.runtime.start(await this.options.getRuntimeOptions())
      }
      if (!this.isCurrent(generation, sessionId)) return
      await this.options.runtime.prompt(sessionId, contentBlocks)
      if (!this.isCurrent(generation, sessionId)) return
      this.options.sidebar.post({ type: 'accepted', sessionId })
    } catch (error) {
      this.options.changeTracker.finish(sessionId)
      if (this.isCurrent(generation, sessionId)) this.options.onError(error)
    }
  }

  async cancelTurn(): Promise<void> {
    ++this.promptGeneration
    this.options.changeTracker.finish(this.activeSessionId)
    try {
      await this.options.runtime.cancelTurn(this.activeSessionId)
    } catch (error) {
      this.options.onError(error)
    }
  }

  async resolveApproval(message: Extract<SidebarMessage, { type: 'approvalDecision' }>): Promise<void> {
    if (message.sessionId !== this.activeSessionId) return
    const pending = this.pendingApprovals.get(message.requestId)
    if (pending === undefined || pending.rootSessionId !== this.activeSessionId || pending.state !== 'pending') return

    pending.state = 'resolving'
    try {
      await this.options.runtime.resolveApproval(pending.agentSessionId, message.requestId, message.outcome)
    } catch (error) {
      pending.state = 'pending'
      this.options.onError(error)
    }
  }

  replayPendingApprovals(): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (pending.rootSessionId !== this.activeSessionId) continue
      this.postApprovalRequest(requestId, pending)
    }
  }

  handleControlEvent(event: ControlEvent): void {
    if (event.method === 'assistant.stream') {
      if (!this.ownsSession(this.activeSessionId, event.sessionId)) return
      this.options.sidebar.post({
        type: 'assistantStream',
        sessionId: this.activeSessionId,
        agentSessionId: event.sessionId,
        frame: event.params.frame,
      })
      return
    }
    if (event.method === 'approval.request') {
      this.handleApprovalRequest(event)
      return
    }
    if (event.method !== 'approval.resolved') return

    const approvalId = stringValue(event.params.approvalId)
    const outcome = event.params.outcome
    if (approvalId === undefined || !isControlApprovalResult(outcome)) return

    const pending = this.pendingApprovals.get(approvalId)
    if (pending === undefined || pending.agentSessionId !== event.sessionId) return
    this.pendingApprovals.delete(approvalId)
    if (pending.rootSessionId !== this.activeSessionId) return
    this.options.sidebar.post({
      type: 'approvalResolved',
      sessionId: pending.rootSessionId,
      requestId: approvalId,
      outcome,
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    ++this.promptGeneration
    await this.rejectPendingApprovals()
    this.options.changeTracker.finish(this.activeSessionId)
    this.disposeRoute()
    this.sessionHierarchy.clear()
  }

  private registerSessionRoute(sessionId: string): void {
    this.sessionRoute = this.options.runtime.registerSession(sessionId, (routed) => {
      this.trackSessionLineage(routed.notification)
      this.trackRuntimeChanges(routed.rootSessionId, routed.notification)
      this.options.sidebar.post({
        type: 'notification',
        sessionId: routed.rootSessionId,
        notification: routed.notification,
      })
    })
  }

  private trackSessionLineage(notification: RoutedNotification['notification']): void {
    const params = notification.params ?? {}
    const childSessionId = stringValue(params.childSessionId)
    this.sessionHierarchy.track(notification.method, params)
    if (notification.method === 'subagent.started' && childSessionId !== undefined) {
      this.flushBufferedApprovals(childSessionId)
    }
  }

  private trackRuntimeChanges(rootSessionId: string, notification: RoutedNotification['notification']): void {
    if (notification.method !== 'session.status') return
    const params = notification.params ?? {}
    if (params.sessionId !== rootSessionId) return
    if (params.status === 'running') this.options.changeTracker.start(rootSessionId)
    else this.options.changeTracker.finish(rootSessionId)
  }

  private handleApprovalRequest(event: ControlEvent): void {
    const approvalId = stringValue(event.params.approvalId)
    const toolName = stringValue(event.params.toolName)
    if (approvalId === undefined || toolName === undefined) return
    if (this.pendingApprovals.has(approvalId) || this.bufferedApprovals.has(approvalId)) return

    if (this.ownsSession(this.activeSessionId, event.sessionId)) {
      this.acceptApproval(event, approvalId, toolName)
      return
    }

    const timer = setTimeout(() => {
      this.bufferedApprovals.delete(approvalId)
      void this.rejectApproval(event.sessionId, approvalId)
    }, APPROVAL_LINEAGE_TIMEOUT_MS)
    this.bufferedApprovals.set(approvalId, { event, timer })
  }

  private acceptApproval(event: ControlEvent, approvalId: string, toolName = stringValue(event.params.toolName) ?? 'Tool call'): void {
    const buffered = this.bufferedApprovals.get(approvalId)
    if (buffered !== undefined) {
      clearTimeout(buffered.timer)
      this.bufferedApprovals.delete(approvalId)
    }

    const pending: PendingApproval = {
      rootSessionId: this.activeSessionId,
      agentSessionId: event.sessionId,
      toolCallId: stringValue(event.params.toolCallId),
      toolName,
      reason: stringValue(event.params.reason),
      state: 'pending',
    }
    this.pendingApprovals.set(approvalId, pending)
    this.postApprovalRequest(approvalId, pending)
  }

  private flushBufferedApprovals(childSessionId: string): void {
    for (const [approvalId, buffered] of this.bufferedApprovals) {
      if (buffered.event.sessionId !== childSessionId) continue
      if (!this.ownsSession(this.activeSessionId, childSessionId)) continue
      this.acceptApproval(buffered.event, approvalId)
    }
  }

  private postApprovalRequest(requestId: string, pending: PendingApproval): void {
    const message: SidebarOutgoingMessage = {
      type: 'approvalRequest',
      sessionId: pending.rootSessionId,
      agentSessionId: pending.agentSessionId,
      requestId,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      reason: pending.reason,
    }
    this.options.sidebar.post(message)
  }

  private async rejectPendingApprovals(): Promise<void> {
    for (const buffered of this.bufferedApprovals.values()) clearTimeout(buffered.timer)
    const pending = [...this.pendingApprovals.entries()]
    this.pendingApprovals.clear()
    this.bufferedApprovals.clear()
    await Promise.allSettled(pending.map(([requestId, approval]) =>
      this.options.runtime.resolveApproval(approval.agentSessionId, requestId, 'rejected'),
    ))
  }

  private async rejectApproval(sessionId: string, requestId: string): Promise<void> {
    try {
      await this.options.runtime.resolveApproval(sessionId, requestId, 'rejected')
    } catch {
      // The session may have ended while lineage was being established.
    }
  }

  private ownsSession(rootSessionId: string, sessionId: string): boolean {
    return this.sessionHierarchy.owns(rootSessionId, sessionId)
  }

  private isCurrent(generation: number, sessionId: string): boolean {
    return !this.disposed && generation === this.promptGeneration && sessionId === this.activeSessionId
  }

  private disposeRoute(): void {
    this.sessionRoute?.dispose()
    this.sessionRoute = undefined
  }
}

function isInactiveRuntimeError(error: unknown): boolean {
  return error instanceof ControlBridgeError && (
    error.code === 'BRIDGE_UNAVAILABLE' ||
    error.code === 'BRIDGE_CLOSED' ||
    error.code === 'BRIDGE_TIMEOUT' ||
    error.code === 'SESSION_NOT_FOUND'
  )
}
