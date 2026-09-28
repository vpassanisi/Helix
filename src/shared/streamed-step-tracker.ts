import { isRecord, responseKey } from './value-utils.js'

export class StreamedStepTracker {
  private readonly streamedSteps = new Set<string>()

  recordLiveFrame(sessionId: string, frame: unknown): void {
    if (!isRecord(frame) || (frame.type !== 'start' && frame.type !== 'chunk')) return
    this.recordStep(sessionId, frame)
  }

  recordDurableChunk(sessionId: string | undefined, data: Record<string, unknown>): void {
    this.recordStep(sessionId ?? '', data)
  }

  hasStreamedStep(sessionId: string | undefined, data: Record<string, unknown>): boolean {
    const key = this.stepKey(sessionId ?? '', data)
    return key !== undefined && this.streamedSteps.has(key)
  }

  reset(): void {
    this.streamedSteps.clear()
  }

  private recordStep(sessionId: string, data: Record<string, unknown>): void {
    const key = this.stepKey(sessionId, data)
    if (key !== undefined) this.streamedSteps.add(key)
  }

  private stepKey(sessionId: string, data: Record<string, unknown>): string | undefined {
    const key = responseKey(data)
    return key === undefined ? undefined : `${sessionId}:${key}`
  }
}
