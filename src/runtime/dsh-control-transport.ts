import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_CAPABILITIES,
  encodeControlEnvelope,
  parseControlLine,
  type ControlEnvelope,
  type ControlEventEnvelope,
  type ControlRequestEnvelope,
} from './control-protocol.js'

export interface ControlTransportHooks {
  /** The Host sent a request for the plugin to handle. */
  onRequest: (request: ControlRequestEnvelope) => void
  /** The socket went away; the transport schedules its own reconnect. */
  onClose?: () => void
}

/**
 * The control channel: one newline-delimited JSON socket to the extension
 * host, with the hello handshake, bounded auto-reconnect and the envelope
 * send helpers every bridge emits through.
 */
export class ControlTransport {
  private socket: Socket | undefined
  private socketBuffer = ''
  private connected = false
  private disposed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly hooks: ControlTransportHooks,
  ) {}

  get isConnected(): boolean {
    return this.connected
  }

  send(envelope: ControlEnvelope): boolean {
    if (!this.connected || this.socket === undefined || this.socket.destroyed) return false
    try {
      this.socket.write(encodeControlEnvelope(envelope))
      return true
    } catch {
      return false
    }
  }

  sendResponse(request: ControlRequestEnvelope, result?: unknown, error?: { code: string; message: string }): void {
    this.send({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'response',
      requestId: request.requestId,
      ok: error === undefined,
      ...(error === undefined ? { result } : { error }),
    })
  }

  sendEvent(sessionId: string, method: ControlEventEnvelope['method'], params: Record<string, unknown>): boolean {
    return this.send({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'event',
      eventId: randomUUID(),
      sessionId,
      method,
      params,
    })
  }

  connect(): void {
    if (this.disposed) return
    const client = createConnection(this.endpoint)
    this.socket = client
    this.socketBuffer = ''
    client.setEncoding('utf8')
    client.on('connect', () => {
      client.write(encodeControlEnvelope({
        version: CONTROL_PROTOCOL_VERSION,
        type: 'hello',
        token: this.token,
        capabilities: CONTROL_CAPABILITIES,
      }))
    })
    client.on('data', (chunk: string) => {
      this.socketBuffer += chunk
      let newlineIndex = this.socketBuffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = this.socketBuffer.slice(0, newlineIndex)
        this.socketBuffer = this.socketBuffer.slice(newlineIndex + 1)
        const envelope = parseControlLine(line)
        if (envelope !== undefined) {
          if (envelope.type === 'helloAck') {
            this.connected = true
            this.reconnectAttempt = 0
          } else if (envelope.type === 'request') {
            this.hooks.onRequest(envelope)
          }
        }
        newlineIndex = this.socketBuffer.indexOf('\n')
      }
    })
    client.on('error', () => {
      this.connected = false
    })
    client.on('close', () => {
      if (this.socket !== client) return
      this.connected = false
      this.socket = undefined
      this.hooks.onClose?.()
      this.scheduleReconnect()
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.connected = false
    this.socket?.destroy()
    this.socket = undefined
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined || this.reconnectAttempt >= 5) return
    const delays = [100, 250, 500, 1_000, 1_000]
    const delay = delays[this.reconnectAttempt] ?? 1_000
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }
}
