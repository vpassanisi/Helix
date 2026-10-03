import { isRecord, responseKey, stringValue } from './value-utils.js'

interface PendingCall {
  sessionId: string
  attemptId: string
  callId: string
  name: string
}

export interface LiveToolCallUpdate {
  prepared?: { callId: string; name: string }
  discard: string[]
}

/** Tracks only identities and names; streamed arguments never enter UI state. */
export class LiveToolCallTracker {
  private readonly steps = new Map<string, string>()
  private readonly calls = new Map<string, PendingCall>()

  recordFrame(sessionId: string, frame: unknown): LiveToolCallUpdate {
    const update: LiveToolCallUpdate = { discard: [] }
    if (!isRecord(frame)) return update
    const attemptId = stringValue(frame.attemptId)
    if (attemptId === undefined) return update
    const attemptKey = this.attemptKey(sessionId, attemptId)

    if (frame.type === 'start') {
      const step = responseKey(frame)
      if (step === undefined) return update
      for (const [key, value] of this.steps) {
        if (key !== attemptKey && key.startsWith(`${sessionId}\0`) && value === step) {
          update.discard.push(...this.clearAttempt(key))
        }
      }
      this.steps.set(attemptKey, step)
      return update
    }

    if (frame.type === 'end') {
      const outcome = isRecord(frame.outcome) ? frame.outcome : undefined
      if (outcome?.kind !== 'committed' || outcome.eventType !== 'assistant/message') {
        update.discard.push(...this.clearAttempt(attemptKey))
      } else {
        this.pruneEmptyAttempts()
      }
      return update
    }

    if (frame.type !== 'chunk' || !isRecord(frame.chunk)) return update
    const chunk = frame.chunk
    if (chunk.type !== 'tool-call-delta' || !Number.isInteger(chunk.index) || (chunk.index as number) < 0) return update
    const callId = stringValue(chunk.id)
    if (callId === undefined) return update
    const key = JSON.stringify([sessionId, attemptId, chunk.index])
    const previous = this.calls.get(key)
    const name = stringValue(chunk.name) ?? previous?.name ?? 'Tool call'
    if (previous?.callId !== undefined && previous.callId !== callId) update.discard.push(previous.callId)
    if (previous?.callId === callId && previous.name === name) return update
    this.calls.set(key, { sessionId, attemptId, callId, name })
    update.prepared = { callId, name }
    return update
  }

  reconcileMessage(sessionId: string, data: Record<string, unknown>): string[] {
    const step = responseKey(data)
    if (step === undefined) return []
    const message = isRecord(data.message) ? data.message : undefined
    const content = Array.isArray(message?.content) ? message.content : []
    const committedIds = new Set(content
      .filter((block) => isRecord(block) && block.type === 'tool-call')
      .map((block) => isRecord(block) ? stringValue(block.id) : undefined)
      .filter((id): id is string => id !== undefined))
    const discard: string[] = []
    for (const [key, call] of this.calls) {
      if (call.sessionId !== sessionId || this.steps.get(this.attemptKey(sessionId, call.attemptId)) !== step) continue
      if (committedIds.has(call.callId)) continue
      discard.push(call.callId)
      this.calls.delete(key)
    }
    this.pruneEmptyAttempts()
    return discard
  }

  finishCall(sessionId: string, callId: string): void {
    for (const [key, call] of this.calls) {
      if (call.sessionId === sessionId && call.callId === callId) this.calls.delete(key)
    }
    this.pruneEmptyAttempts()
  }

  clearStep(sessionId: string, data: Record<string, unknown>): string[] {
    const step = responseKey(data)
    if (step === undefined) return []
    const discard: string[] = []
    for (const [key, value] of this.steps) {
      if (key.startsWith(`${sessionId}\0`) && value === step) discard.push(...this.clearAttempt(key))
    }
    return discard
  }

  clear(sessionId?: string): string[] {
    const discard: string[] = []
    for (const [key, call] of this.calls) {
      if (sessionId !== undefined && call.sessionId !== sessionId) continue
      discard.push(call.callId)
      this.calls.delete(key)
    }
    for (const key of this.steps.keys()) {
      if (sessionId === undefined || key.startsWith(`${sessionId}\0`)) this.steps.delete(key)
    }
    return discard
  }

  private clearAttempt(attemptKey: string): string[] {
    const discard: string[] = []
    for (const [key, call] of this.calls) {
      if (this.attemptKey(call.sessionId, call.attemptId) !== attemptKey) continue
      discard.push(call.callId)
      this.calls.delete(key)
    }
    this.steps.delete(attemptKey)
    return discard
  }

  private attemptKey(sessionId: string, attemptId: string): string {
    return `${sessionId}\0${attemptId}`
  }

  private pruneEmptyAttempts(): void {
    const active = new Set([...this.calls.values()].map((call) => this.attemptKey(call.sessionId, call.attemptId)))
    for (const key of this.steps.keys()) {
      if (!active.has(key)) this.steps.delete(key)
    }
  }
}
