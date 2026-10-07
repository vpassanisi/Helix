import { isRecord } from '../shared/value-utils.js'

export interface BrowserCdpTransport {
  onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void }
  onDidClose(listener: () => void): { dispose(): void }
  sendMessage(message: unknown): PromiseLike<void>
  close(): PromiseLike<void>
}

export class BrowserCdpClient {
  private nextId = 1
  private closed = false
  private readonly pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly subscriptions: Array<{ dispose(): void }>

  constructor(private readonly transport: BrowserCdpTransport, private readonly onEvent: (event: Record<string, unknown>) => void, private readonly onClose: () => void, private readonly timeoutMs = 5_000) {
    this.subscriptions = [
      transport.onDidReceiveMessage((value) => this.receive(value)),
      transport.onDidClose(() => { this.dispose(); onClose() }),
    ]
  }

  request(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('Browser connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Browser request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      Promise.resolve(this.transport.sendMessage({ id, method, params, ...(sessionId ? { sessionId } : {}) })).catch((error: unknown) => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  private receive(value: unknown): void {
    if (this.closed || !isRecord(value)) return
    if (typeof value.id === 'number') {
      const pending = this.pending.get(value.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(value.id)
      if (isRecord(value.error)) pending.reject(new Error(String(value.error.message ?? 'Browser request failed')))
      else pending.resolve(isRecord(value.result) ? value.result : {})
    } else if (typeof value.method === 'string') this.onEvent(value)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const subscription of this.subscriptions) subscription.dispose()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Browser connection is closed'))
    }
    this.pending.clear()
  }

  async close(): Promise<void> {
    this.dispose()
    await this.transport.close()
  }
}
