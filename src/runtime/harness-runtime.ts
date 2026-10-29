import { rm, writeFile } from 'node:fs/promises'
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
import { createClientOptions, createRuntimePatch, type ContextPatch } from './runtime-context-patch.js'
import { createElectronHarnessClient, ELECTRON_DSH_LAUNCHER } from './electron-launcher.js'
import { SerialTaskQueue } from './serial-task-queue.js'
import type { UserQuestionAnswer } from '../shared/user-question.js'
import { stringValue } from '../shared/value-utils.js'
import type { SkillCatalog, SkillTurnSelection } from '../shared/skills.js'
import type { CommandCatalog } from '../shared/commands.js'
import type { ControlCommandResult } from './control-protocol.js'
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
  private readonly createClient: (options: HarnessClientOptions, launcherDirectory?: string) => Promise<HarnessClient> | HarnessClient
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
    this.createClient = options.createClient ?? (async (clientOptions, launcherDirectory) => {
      if (process.versions.electron === undefined || launcherDirectory === undefined) {
        return new HarnessClient(clientOptions)
      }

      const launcherPath = join(launcherDirectory, 'dsh-electron-launcher.mjs')
      await writeFile(launcherPath, ELECTRON_DSH_LAUNCHER, 'utf8')
      return createElectronHarnessClient(clientOptions, launcherPath)
    })
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
      contextPatch = await createRuntimePatch(options)
      const clientOptions = createClientOptions(options, controlBridge, contextPatch)

      client = await this.createClient(clientOptions, contextPatch?.directory)
      client.start()
      handle = {
        client,
        controlBridge,
        generation,
        contextPatchDirectory: contextPatch?.directory,
      }
      this.handle = handle
      this.attachSessionRoutes(client, generation)

      await waitWithTimeout(client.initialize({
        cwd: options.cwd,
        provider: options.provider,
        model: options.model,
      }), 30_000, 'DSH did not finish initializing within 30 seconds.')
      const connected = await controlBridge.waitForConnection(5_000)
      if (!connected) {
        throw new ControlBridgeError('The DSH control bridge did not connect.', 'BRIDGE_TIMEOUT')
      }
      await this.resumePersistedSessions(client)
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

  /**
   * A restarted runtime reopens its persisted sessions from disk, so an id a
   * previous generation minted is already present in the fresh process: the
   * next prompt would try to create it again and fail with
   * "session … already exists". Resume each routed id so the running session
   * keeps its identity and history across restarts. An id that was never
   * minted has no persisted log; its failure is swallowed because the next
   * prompt mints it fresh.
   */
  private async resumePersistedSessions(client: HarnessClient): Promise<void> {
    for (const route of [...this.sessionRoutes]) {
      try {
        await client.resumeSession(route.rootSessionId)
      } catch {
        // The id was never persisted; the next prompt creates it.
      }
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

  async waitForSession(sessionId: string): Promise<void> {
    const handle = this.requireHandle()
    try {
      await handle.client.request('session/wait', { sessionId })
    } catch (error) {
      await this.handleClientFailure(handle.client, handle.generation, error)
      throw error
    }
  }

  /**
   * Open the DSH Agent behind a session before its first prompt. The runtime
   * mints a session on its first prompt or working-directory operation, and a
   * Host composer command needs the Agent, so warming a session is what makes
   * `/plan` and every other command the first thing typed resolve.
   * Silent when the runtime is not ready: the caller decides when to start it.
   */
  async ensureSession(sessionId: string): Promise<void> {
    const handle = this.handle
    if (handle === undefined || this.state !== 'ready') return
    try {
      await handle.client.getWorkingDirectory(sessionId)
    } catch (error) {
      await this.handleClientFailure(handle.client, handle.generation, error)
      throw error
    }
  }

  async skillCatalog(sessionId: string): Promise<SkillCatalog> {
    const bridge = this.handle?.controlBridge
    if (!bridge?.skillCatalog) throw new Error('Skill discovery is unavailable in this runtime.')
    return bridge.skillCatalog(sessionId)
  }
  async stageSkills(sessionId: string, selection: SkillTurnSelection): Promise<void> {
    const bridge = this.handle?.controlBridge
    if (!bridge?.stageSkills) throw new Error('Skill preloading is unavailable in this runtime.')
    await bridge.stageSkills(sessionId, selection)
  }
  async clearSkills(sessionId: string): Promise<void> { await this.handle?.controlBridge.clearSkills?.(sessionId) }

  /**
   * A model card's own instructions, staged for one session. Best-effort: an
   * older runtime plugin has no such method, and a missing model card note must
   * never block a message.
   */
  async stageModelInstructions(sessionId: string, instructions: string | null): Promise<void> {
    await this.handle?.controlBridge.stageModelInstructions?.(sessionId, instructions)
  }
  async clearModelInstructions(sessionId: string): Promise<void> { await this.handle?.controlBridge.clearModelInstructions?.(sessionId) }

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

  async answerQuestion(sessionId: string, requestId: string, answer: UserQuestionAnswer): Promise<void> {
    await this.requireHandle().controlBridge.answerQuestion(sessionId, requestId, answer)
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

  async setReasoningEffort(sessionId: string, reasoningEffort: string | null): Promise<void> {
    const handle = this.requireHandle()
    await handle.controlBridge.setReasoningEffort(sessionId, reasoningEffort)
  }

  /**
   * The Host command registry for one session, which is where `/compact` and
   * every other composer command lives. An older bridge without the capability
   * is reported as unavailable, not as an empty catalog.
   */
  async commandCatalog(sessionId: string): Promise<CommandCatalog> {
    const bridge = this.handle?.controlBridge
    if (bridge === undefined || !bridge.capabilities.includes('commands.catalog')) {
      return { commands: [], available: false }
    }
    return bridge.commandCatalog(sessionId)
  }

  async runCommand(sessionId: string, name: string, args: string): Promise<ControlCommandResult> {
    const handle = this.requireHandle()
    if (!handle.controlBridge.capabilities.includes('session.command')) {
      throw new Error('The running Harness does not accept composer commands.')
    }
    return handle.controlBridge.runCommand(sessionId, name, args)
  }

  async armRequestPreview(sessionId: string, captureId: string): Promise<void> {
    const handle = this.requireHandle()
    await handle.controlBridge.armRequestPreview(sessionId, captureId)
  }

  async captureNextProviderRequest(sessionId: string): Promise<void> {
    const handle = this.requireHandle()
    await handle.controlBridge.captureNextProviderRequest(sessionId)
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

    try {
      await this.cleanupHandle(handle)
    } catch (error) {
      this.setState({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      throw error
    }
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
    if (client !== undefined) {
      await waitWithTimeout(client.close(), 15_000, 'Timed out while closing the DSH runtime.')
        .catch((error) => this.reportLifecycleError(error))
    }
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
      await waitWithTimeout(handle.client.close(), 15_000, 'Timed out while closing the DSH runtime.')
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

async function waitWithTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
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
