import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_CAPABILITIES,
  encodeControlEnvelope,
  isControlRequestMethod,
  parseControlLine,
  type ControlApprovalOutcome,
  type ControlEnvelope,
  type ControlEventEnvelope,
  type ControlRequestEnvelope,
  type ControlRequestMethod,
  type ControlResponseEnvelope,
} from './control-protocol.js'

export interface ControlEvent {
  eventId: string
  sessionId: string
  method: ControlEventEnvelope['method']
  params: Record<string, unknown>
}

export interface ControlBridgeOptions {
  onEvent?: (event: ControlEvent) => void
}

export interface ControlBroker {
  readonly endpoint: string | undefined
  readonly token: string | undefined
  readonly connected: boolean
  readonly capabilities: readonly ControlRequestMethod[]
  start(): Promise<void>
  waitForConnection(timeoutMs?: number): Promise<boolean>
  cancel(sessionId: string, authoritySessionId?: string): Promise<void>
  resolveApproval(sessionId: string, requestId: string, outcome: ControlApprovalOutcome): Promise<void>
  steer(sessionId: string, text: string, authoritySessionId?: string): Promise<void>
  inject(sessionId: string, text: string, authoritySessionId?: string): Promise<void>
  setApprovalPolicy(sessionId: string, policy: 'ask' | 'never', authoritySessionId?: string): Promise<void>
  setSandboxMode(sessionId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access', authoritySessionId?: string): Promise<void>
  close(): Promise<void>
}

export class ControlBridgeError extends Error {
  constructor(
    message: string,
    readonly code: 'BRIDGE_UNAVAILABLE' | 'BRIDGE_TIMEOUT' | 'BRIDGE_CLOSED' | 'BRIDGE_PROTOCOL' | 'BRIDGE_REQUEST',
  ) {
    super(message)
    this.name = 'ControlBridgeError'
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export class LocalControlBridge implements ControlBroker {
  private server: Server | undefined
  private socket: Socket | undefined
  private controlDirectory: string | undefined
  private connectionWaiters = new Set<(connected: boolean) => void>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<(event: ControlEvent) => void>()
  private readonly eventCallback?: (event: ControlEvent) => void
  private closed = false
  private authenticated = false
  private _capabilities: ControlRequestMethod[] = []

  constructor(options: ControlBridgeOptions = {}) {
    this.eventCallback = options.onEvent
  }

  get endpoint(): string | undefined {
    if (process.platform === 'win32') return this.controlDirectory
    return this.controlDirectory === undefined ? undefined : join(this.controlDirectory, 'control.sock')
  }

  get token(): string | undefined {
    return this.authToken
  }

  get capabilities(): readonly ControlRequestMethod[] {
    return this._capabilities
  }

  get connected(): boolean {
    return this.socket !== undefined && this.authenticated && !this.closed
  }

  private readonly authToken = randomUUID()

  async start(): Promise<void> {
    if (this.server !== undefined) return
    this.closed = false
    this.controlDirectory = process.platform === 'win32'
      ? `\\\\.\\pipe\\helix-control-${randomUUID()}`
      : await mkdtemp(join(tmpdir(), 'helix-control-'))

    const endpoint = this.endpoint
    if (endpoint === undefined) throw new ControlBridgeError('Control endpoint was not created.', 'BRIDGE_PROTOCOL')

    this.server = createServer((socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      const server = this.server
      if (server === undefined) return reject(new Error('Control server was not created.'))
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(endpoint)
    })
  }

  async waitForConnection(timeoutMs = 1_500): Promise<boolean> {
    if (this.connected) return true
    if (this.closed) return false

    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (connected: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.connectionWaiters.delete(finish)
        resolve(connected)
      }
      const timer = setTimeout(() => finish(this.connected), timeoutMs)
      this.connectionWaiters.add(finish)
    })
  }

  onEvent(listener: (event: ControlEvent) => void): { dispose(): void } {
    this.eventListeners.add(listener)
    return { dispose: () => this.eventListeners.delete(listener) }
  }

  async request(
    method: ControlRequestMethod,
    sessionId: string,
    params: Record<string, unknown> = {},
    timeoutMs = 5_000,
  ): Promise<unknown> {
    if (!this.connected || this.socket === undefined) {
      throw new ControlBridgeError('The DSH control bridge is not connected.', 'BRIDGE_UNAVAILABLE')
    }
    if (this._capabilities.length > 0 && !this._capabilities.includes(method)) {
      throw new ControlBridgeError(`The DSH bridge does not support ${method}.`, 'BRIDGE_UNAVAILABLE')
    }

    const requestId = randomUUID()
    const envelope: ControlRequestEnvelope = {
      version: CONTROL_PROTOCOL_VERSION,
      type: 'request' as const,
      requestId,
      sessionId,
      method,
      params,
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new ControlBridgeError(`${method} timed out.`, 'BRIDGE_TIMEOUT'))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.socket?.write(encodeControlEnvelope(envelope))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new ControlBridgeError(String(error), 'BRIDGE_CLOSED'))
      }
    })
  }

  async cancel(sessionId: string, authoritySessionId = sessionId): Promise<void> {
    await this.request('turn.cancel', sessionId, { authoritySessionId })
  }

  async resolveApproval(
    sessionId: string,
    requestId: string,
    outcome: ControlApprovalOutcome,
  ): Promise<void> {
    await this.request('approval.resolve', sessionId, { approvalId: requestId, outcome })
  }

  async steer(sessionId: string, text: string, authoritySessionId = sessionId): Promise<void> {
    await this.request('session.steer', sessionId, { text, authoritySessionId })
  }

  async inject(sessionId: string, text: string, authoritySessionId = sessionId): Promise<void> {
    await this.request('session.inject', sessionId, { text, authoritySessionId })
  }

  async setApprovalPolicy(sessionId: string, policy: 'ask' | 'never', authoritySessionId = sessionId): Promise<void> {
    await this.request('session.setApprovalPolicy', sessionId, { policy, authoritySessionId })
  }

  async setSandboxMode(
    sessionId: string,
    mode: 'read-only' | 'workspace-write' | 'danger-full-access',
    authoritySessionId = sessionId,
  ): Promise<void> {
    await this.request('session.setSandboxMode', sessionId, { mode, authoritySessionId })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.resolveConnectionWaiters(false)
    const error = new ControlBridgeError('The DSH control bridge was closed.', 'BRIDGE_CLOSED')
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(requestId)
    }

    const socket = this.socket
    this.socket = undefined
    this.authenticated = false
    this._capabilities = []
    socket?.destroy()

    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      })
    }

    const directory = this.controlDirectory
    this.controlDirectory = undefined
    if (directory !== undefined && process.platform !== 'win32') {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private handleConnection(socket: Socket): void {
    if (this.closed || this.socket !== undefined) {
      socket.destroy()
      return
    }

    socket.setEncoding('utf8')
    let authenticated = false
    const handshakeTimer = setTimeout(() => socket.destroy(), 3_000)
    let buffer = ''

    const onLine = (line: string) => {
      const envelope = parseControlLine(line)
      if (envelope === undefined) {
        socket.destroy()
        return
      }

      if (!authenticated) {
        if (envelope.type !== 'hello' || envelope.token !== this.authToken) {
          socket.destroy()
          return
        }
        authenticated = true
        clearTimeout(handshakeTimer)
        this.socket = socket
        this.authenticated = true
        const offeredCapabilities = Array.isArray(envelope.capabilities)
          ? envelope.capabilities.filter(isControlRequestMethod)
          : []
        this._capabilities = offeredCapabilities.length > 0
          ? offeredCapabilities
          : [...CONTROL_CAPABILITIES]
        socket.write(encodeControlEnvelope({
          version: CONTROL_PROTOCOL_VERSION,
          type: 'helloAck',
          capabilities: this._capabilities,
        }))
        this.resolveConnectionWaiters(true)
        return
      }

      this.handleEnvelope(envelope)
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        onLine(line)
        newlineIndex = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(handshakeTimer)
      if (this.socket !== socket) return
      this.socket = undefined
      this.authenticated = false
      this._capabilities = []
      this.rejectPending(new ControlBridgeError('The DSH control bridge disconnected.', 'BRIDGE_CLOSED'))
    })
  }

  private handleEnvelope(envelope: ControlEnvelope): void {
    if (envelope.type === 'response') {
      this.handleResponse(envelope)
      return
    }
    if (envelope.type === 'event') {
      const event: ControlEvent = {
        eventId: envelope.eventId,
        sessionId: envelope.sessionId,
        method: envelope.method,
        params: envelope.params,
      }
      try {
        this.eventCallback?.(event)
      } catch {
        // A host event consumer must not take down the socket dispatcher.
      }
      for (const listener of this.eventListeners) {
        try {
          listener(event)
        } catch {
          // A diagnostic listener must not affect control traffic.
        }
      }
    }
  }

  private handleResponse(response: ControlResponseEnvelope): void {
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok) {
      pending.resolve(response.result)
    } else {
      pending.reject(new ControlBridgeError(
        response.error?.message ?? 'The DSH bridge rejected the request.',
        'BRIDGE_REQUEST',
      ))
    }
  }

  private rejectPending(error: ControlBridgeError): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(requestId)
    }
  }

  private resolveConnectionWaiters(connected: boolean): void {
    for (const resolve of [...this.connectionWaiters]) resolve(connected)
  }
}
