import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HarnessClient,
  type ContentBlock,
  type HarnessClientOptions,
  type HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client'
import {
  ControlBridgeError,
  LocalControlBridge,
  type ControlBroker,
  type ControlBridgeOptions,
  type ControlEvent,
} from './control-bridge.js'
import { builtInWebPatchLines, mcpEnvironmentVariable, mcpPatchLines } from './mcp.js'
import { SerialTaskQueue } from './serial-task-queue.js'
import { stringValue } from '../shared/value-utils.js'
import type {
  DisposableLike,
  RoutedNotification,
  RuntimeOptions,
  RuntimeState,
} from './types.js'

export interface RuntimeStateChange {
  state: RuntimeState
  message?: string
}

interface SessionRoute {
  rootSessionId: string
  handler: (notification: RoutedNotification) => void
  client?: HarnessClient
  subscription?: ReturnType<HarnessClient['subscribeSessionTree']>
}

interface RuntimeHandle {
  client: HarnessClient
  controlBridge: ControlBroker
  generation: number
  contextPatchDirectory?: string
}

interface ContextPatch {
  path: string
  directory: string
}

export class HarnessRuntime {
  private handle: RuntimeHandle | undefined
  private cleanupTask: Promise<void> | undefined
  private generation = 0
  private state: RuntimeState = 'stopped'
  private readonly stateListeners = new Set<(change: RuntimeStateChange) => void>()
  private readonly sessionRoutes = new Set<SessionRoute>()
  private readonly onHandlerError?: (error: unknown, notification: HarnessNotification) => void
  private readonly onControlEvent?: (event: ControlEvent) => void
  private readonly onLifecycleError?: (error: unknown) => void
  private readonly createControlBridge: (options: ControlBridgeOptions) => ControlBroker
  private readonly createClient: (options: HarnessClientOptions) => HarnessClient
  private readonly lifecycleQueue = new SerialTaskQueue()
  private readonly cleanupHandles = new WeakMap<RuntimeHandle, Promise<void>>()

  constructor(options: {
    onHandlerError?: (error: unknown, notification: HarnessNotification) => void
    onControlEvent?: (event: ControlEvent) => void
    onLifecycleError?: (error: unknown) => void
    createControlBridge?: (options: ControlBridgeOptions) => ControlBroker
    createClient?: (options: HarnessClientOptions) => HarnessClient
  } = {}) {
    this.onHandlerError = options.onHandlerError
    this.onControlEvent = options.onControlEvent
    this.onLifecycleError = options.onLifecycleError
    this.createControlBridge = options.createControlBridge ?? ((bridgeOptions) => new LocalControlBridge(bridgeOptions))
    this.createClient = options.createClient ?? ((clientOptions) => new HarnessClient(clientOptions))
  }

  get currentState(): RuntimeState {
    return this.state
  }

  onStateChange(listener: (change: RuntimeStateChange) => void): DisposableLike {
    this.stateListeners.add(listener)
    return { dispose: () => this.stateListeners.delete(listener) }
  }

  registerSession(
    rootSessionId: string,
    handler: (notification: RoutedNotification) => void,
  ): DisposableLike {
    const route: SessionRoute = { rootSessionId, handler }
    this.sessionRoutes.add(route)
    if (this.handle !== undefined) this.attachSessionRoute(route, this.handle.client, this.handle.generation)

    return {
      dispose: () => {
        if (!this.sessionRoutes.delete(route)) return
        this.disposeSessionRoute(route)
      },
    }
  }

  async start(options: RuntimeOptions): Promise<void> {
    return this.enqueueLifecycle(async () => {
      await this.cleanupTask
      await this.startInternal(options)
    })
  }

  private async startInternal(options: RuntimeOptions): Promise<void> {
    if (this.handle !== undefined) return

    this.setState({ state: 'starting' })
    const generation = ++this.generation
    const controlBridge = this.createControlBridge({ onEvent: this.onControlEvent })
    let contextPatch: ContextPatch | undefined
    let client: HarnessClient | undefined
    let handle: RuntimeHandle | undefined

    try {
      await controlBridge.start()
      contextPatch = await this.createContextPatch(options)
      const clientOptions = createClientOptions(options, controlBridge, contextPatch)

      client = this.createClient(clientOptions)
      client.start()
      handle = {
        client,
        controlBridge,
        generation,
        contextPatchDirectory: contextPatch?.directory,
      }
      this.handle = handle
      this.attachSessionRoutes(client, generation)

      await client.initialize({
        cwd: options.cwd,
        provider: options.provider,
        model: options.model,
      })
      const connected = await controlBridge.waitForConnection(5_000)
      if (!connected) {
        throw new ControlBridgeError('The DSH control bridge did not connect.', 'BRIDGE_TIMEOUT')
      }
      this.setState({ state: 'ready' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ state: 'error', message })
      throw error
    } finally {
      if (this.state === 'ready' && this.handle === handle && handle !== undefined) return
      await this.cleanupFailedStart(handle, client, controlBridge, contextPatch)
    }
  }

  async prompt(sessionId: string, contentBlocks: ContentBlock[]): Promise<string> {
    const handle = this.handle
    if (handle === undefined || this.state !== 'ready') throw new Error('Helix runtime is not ready')
    try {
      return await handle.client.prompt(sessionId, contentBlocks)
    } catch (error) {
      await this.handleClientFailure(handle.client, handle.generation, error)
      throw error
    }
  }

  async cancelTurn(sessionId: string): Promise<void> {
    try {
      const handle = this.handle
      if (handle === undefined) return
      if (!handle.controlBridge.connected) {
        throw new ControlBridgeError('The DSH control bridge is not connected.', 'BRIDGE_UNAVAILABLE')
      }
      await handle.controlBridge.cancel(sessionId)
    } catch (error) {
      if (error instanceof ControlBridgeError && (
        error.code === 'BRIDGE_UNAVAILABLE' ||
        error.code === 'BRIDGE_TIMEOUT' ||
        error.code === 'BRIDGE_CLOSED' ||
        error.code === 'SESSION_NOT_FOUND'
      )) {
        await this.stop()
        return
      }
      throw error
    }
  }

  async resolveApproval(sessionId: string, requestId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const handle = this.handle
    if (handle === undefined) {
      throw new ControlBridgeError('The DSH control bridge is not connected.', 'BRIDGE_UNAVAILABLE')
    }
    await handle.controlBridge.resolveApproval(sessionId, requestId, outcome)
  }

  async steer(sessionId: string, text: string): Promise<void> {
    const handle = this.requireHandle()
    await handle.controlBridge.steer(sessionId, text)
  }

  async inject(sessionId: string, text: string): Promise<void> {
    const handle = this.requireHandle()
    await handle.controlBridge.inject(sessionId, text)
  }

  async setApprovalPolicy(sessionId: string, policy: 'ask' | 'never'): Promise<void> {
    const handle = this.requireHandle()
    await handle.controlBridge.setApprovalPolicy(sessionId, policy)
  }

  async setSandboxMode(sessionId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void> {
    const handle = this.requireHandle()
    await handle.controlBridge.setSandboxMode(sessionId, mode)
  }

  async restart(options: RuntimeOptions): Promise<void> {
    return this.enqueueLifecycle(async () => {
      await this.stopInternal()
      await this.startInternal(options)
    })
  }

  async stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopInternal())
  }

  private async stopInternal(): Promise<void> {
    await this.cleanupTask
    const handle = this.handle
    if (handle === undefined) {
      this.setState({ state: 'stopped' })
      return
    }

    await this.cleanupHandle(handle)
    this.setState({ state: 'stopped' })
  }

  async dispose(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      for (const route of [...this.sessionRoutes]) this.disposeSessionRoute(route)
      this.sessionRoutes.clear()
      await this.stopInternal()
      this.stateListeners.clear()
    })
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    return this.lifecycleQueue.run(operation)
  }

  private attachSessionRoutes(client: HarnessClient, generation: number): void {
    for (const route of this.sessionRoutes) this.attachSessionRoute(route, client, generation)
  }

  private disposeSessionRoute(route: SessionRoute): void {
    route.subscription?.close()
    route.subscription = undefined
    route.client = undefined
  }

  private attachSessionRoute(route: SessionRoute, client: HarnessClient, generation: number): void {
    if (route.client === client && route.subscription !== undefined) return
    route.subscription?.close()
    const subscription = client.subscribeSessionTree(route.rootSessionId)
    route.client = client
    route.subscription = subscription
    void this.consumeSessionRoute(route, client, subscription, generation)
  }

  private async consumeSessionRoute(
    route: SessionRoute,
    client: HarnessClient,
    subscription: ReturnType<HarnessClient['subscribeSessionTree']>,
    generation: number,
  ): Promise<void> {
    try {
      for await (const notification of subscription) {
        if (
          generation !== this.generation ||
          route.client !== client ||
          route.subscription !== subscription
        ) continue

        const sessionId = notificationSessionId(notification)
        if (sessionId === undefined) continue
        try {
          route.handler({ rootSessionId: route.rootSessionId, sessionId, notification })
        } catch (error) {
          try {
            this.onHandlerError?.(error, notification)
          } catch (diagnosticError) {
            this.onLifecycleError?.(diagnosticError)
          }
        }
      }
    } catch (error) {
      if (
        generation !== this.generation ||
        this.state === 'stopped' ||
        route.client !== client ||
        route.subscription !== subscription
      ) return
      await this.handleClientFailure(client, generation, error)
    }
  }

  private async handleClientFailure(client: HarnessClient, generation: number, error: unknown): Promise<void> {
    const handle = this.handle
    if (generation !== this.generation || handle?.client !== client) return
    const message = error instanceof Error ? error.message : String(error)
    this.setState({ state: 'error', message })
    const cleanup = this.cleanupHandle(handle)
    this.cleanupTask = cleanup
    try {
      await cleanup
    } catch (cleanupError) {
      this.reportLifecycleError(cleanupError)
    } finally {
      if (this.cleanupTask === cleanup) this.cleanupTask = undefined
    }
  }

  private async cleanupHandle(handle: RuntimeHandle): Promise<void> {
    const existing = this.cleanupHandles.get(handle)
    if (existing !== undefined) return existing
    const cleanup = this.performCleanup(handle)
    this.cleanupHandles.set(handle, cleanup)
    return cleanup
  }

  private async cleanupFailedStart(
    handle: RuntimeHandle | undefined,
    client: HarnessClient | undefined,
    controlBridge: ControlBroker,
    contextPatch: ContextPatch | undefined,
  ): Promise<void> {
    if (handle !== undefined) {
      await this.cleanupHandle(handle).catch((error) => this.reportLifecycleError(error))
      return
    }
    if (client !== undefined) await client.close().catch((error) => this.reportLifecycleError(error))
    await controlBridge.close().catch((error) => this.reportLifecycleError(error))
    if (contextPatch !== undefined) {
      await rm(contextPatch.directory, { recursive: true, force: true }).catch((error) => this.reportLifecycleError(error))
    }
  }

  private async performCleanup(handle: RuntimeHandle): Promise<void> {
    this.generation += 1
    for (const route of this.sessionRoutes) {
      if (route.client !== handle.client) continue
      route.subscription?.close()
      route.subscription = undefined
      route.client = undefined
    }
    try {
      await handle.client.close()
    } finally {
      if (this.handle === handle) this.handle = undefined
      try {
        await handle.controlBridge.close()
      } finally {
        if (handle.contextPatchDirectory !== undefined) {
          await rm(handle.contextPatchDirectory, { recursive: true, force: true })
        }
      }
    }
  }

  private async createContextPatch(options: RuntimeOptions): Promise<ContextPatch | undefined> {
    const contextWindow = options.contextWindow
    const hasContextWindow = contextWindow !== undefined && Number.isSafeInteger(contextWindow) && contextWindow > 0

    const directory = await mkdtemp(join(tmpdir(), 'dsh-vscode-'))
    const patchPath = join(directory, 'runtime.patch.yml')
    const patchLines: string[] = []
    if (hasContextWindow) {
      patchLines.push(
        '- id: llm-deepseek',
        '  config:',
        `    defaultContextWindow: ${contextWindow}`,
        '    models:',
        `      - id: ${yamlString(options.model)}`,
        `        contextWindow: ${contextWindow}`,
        '- id: llm-pi-ai',
        '  config:',
        `    defaultContextWindow: ${contextWindow}`,
      )
      if (options.provider !== 'deepseek-official') {
        patchLines.push(
          '    providers:',
          `      ${yamlString(options.provider)}:`,
          `        defaultContextWindow: ${contextWindow}`,
          '        models:',
          `          - id: ${yamlString(options.model)}`,
          `            contextWindow: ${contextWindow}`,
        )
      }
    }
    patchLines.push(
      '- insert:',
      '    - id: helix-control-bridge',
      `      name: ${yamlString(new URL('./dsh-control-plugin.js', import.meta.url).href)}`,
    )
    patchLines.push(...builtInWebPatchLines())
    patchLines.push(
      '- id: sandbox-policy',
      '  config:',
      `    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`,
      `    workspaceRoot: ${yamlString(options.cwd)}`,
    )
    patchLines.push(...mcpPatchLines(options.mcpServers))
    const patch = `${patchLines.join('\n')}\n`

    try {
      await writeFile(patchPath, patch, 'utf8')
      return { path: patchPath, directory }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  private requireHandle(): RuntimeHandle {
    if (this.handle === undefined || this.state !== 'ready') {
      throw new ControlBridgeError('The DSH control bridge is not connected.', 'BRIDGE_UNAVAILABLE')
    }
    return this.handle
  }

  private setState(change: RuntimeStateChange): void {
    this.state = change.state
    for (const listener of this.stateListeners) {
      try {
        listener(change)
      } catch (error) {
        this.reportLifecycleError(error)
      }
    }
  }

  private reportLifecycleError(error: unknown): void {
    try {
      this.onLifecycleError?.(error)
    } catch {
      // Diagnostics must not break runtime cleanup.
    }
  }
}

function notificationSessionId(notification: HarnessNotification): string | undefined {
  const params = notification.params ?? {}
  if (notification.method === 'session.event' || notification.method === 'session.status') {
    return stringValue(params.sessionId)
  }
  if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
    return stringValue(params.childSessionId) ?? stringValue(params.parentSessionId)
  }
  return undefined
}

function createClientOptions(
  options: RuntimeOptions,
  controlBridge: ControlBroker,
  contextPatch: ContextPatch | undefined,
): HarnessClientOptions {
  const env = createRuntimeEnvironment(options, controlBridge)
  return {
    dshBin: options.dshBin,
    profile: 'sdk',
    patches: contextPatch === undefined ? undefined : [contextPatch.path],
    dshHome: options.dshHome,
    processCwd: options.cwd,
    env,
  }
}

function createRuntimeEnvironment(options: RuntimeOptions, controlBridge: ControlBroker): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HELIX_CONTROL_ENDPOINT: controlBridge.endpoint,
    HELIX_CONTROL_TOKEN: controlBridge.token,
    DSH_PERMISSION_MODE: options.sandboxMode,
  }
  if (options.dshHome !== undefined) env.DSH_HOME = options.dshHome
  if (options.apiKey !== undefined) env.DEEPSEEK_API_KEY = options.apiKey
  if (options.baseUrl !== undefined) env.DEEPSEEK_BASE_URL = options.baseUrl
  for (const server of options.mcpServers) {
    for (const [environmentName, value] of Object.entries(server.env)) {
      env[mcpEnvironmentVariable(server.serverName, environmentName)] = value
    }
  }
  return env
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}
