import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HarnessClient,
  type ContentBlock,
  type HarnessClientOptions,
  type HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client'
import { SessionNotificationRouter } from './session-router.js'
import { ControlBridgeError, LocalControlBridge, type ControlBroker, type ControlEvent } from './control-bridge.js'
import { builtInWebPatchLines, mcpEnvironmentVariable, mcpPatchLines } from './mcp.js'
import { SerialTaskQueue } from './serial-task-queue.js'
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

export class HarnessRuntime {
  private client: HarnessClient | undefined
  private subscription: ReturnType<HarnessClient['subscribe']> | undefined
  private generation = 0
  private state: RuntimeState = 'stopped'
  private readonly stateListeners = new Set<(change: RuntimeStateChange) => void>()
  private readonly router: SessionNotificationRouter
  private contextPatchDirectory: string | undefined
  private controlBroker: ControlBroker | undefined
  private readonly onControlEvent?: (event: ControlEvent) => void
  private readonly lifecycleQueue = new SerialTaskQueue()

  constructor(options: {
    onUnrouted?: (notification: HarnessNotification) => void
    onHandlerError?: (error: unknown, notification: HarnessNotification) => void
    onControlEvent?: (event: ControlEvent) => void
  } = {}) {
    this.router = new SessionNotificationRouter(options)
    this.onControlEvent = options.onControlEvent
  }

  get currentState(): RuntimeState {
    return this.state
  }

  onStateChange(listener: (change: RuntimeStateChange) => void): DisposableLike {
    this.stateListeners.add(listener)
    return { dispose: () => this.stateListeners.delete(listener) }
  }

  registerSession(
    sessionId: string,
    handler: (notification: RoutedNotification) => void,
    mode: 'exact' | 'tree' = 'tree',
  ): DisposableLike {
    return this.router.register(sessionId, handler, mode)
  }

  ownsSession(rootSessionId: string, sessionId: string): boolean {
    return this.router.owns(rootSessionId, sessionId)
  }

  async start(options: RuntimeOptions): Promise<void> {
    return this.enqueueLifecycle(() => this.startInternal(options))
  }

  private async startInternal(options: RuntimeOptions): Promise<void> {
    if (this.client !== undefined) return

    this.setState({ state: 'starting' })
    const generation = ++this.generation
    const controlBridge = new LocalControlBridge({ onEvent: this.onControlEvent })
    let contextPatchPath: string | undefined
    try {
      await controlBridge.start()
      this.controlBroker = controlBridge
      contextPatchPath = await this.createContextPatch(options)
    } catch (error) {
      await controlBridge.close().catch(() => undefined)
      if (this.controlBroker === controlBridge) this.controlBroker = undefined
      await this.removeContextPatch()
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ state: 'error', message })
      throw error
    }
    const command = options.dshBin || (process.platform === 'win32' ? 'npx.cmd' : 'npx')
    const args = options.dshBin
      ? ['--profile', 'sdk']
      : ['--yes', '--package', '@deepseek-ai/dsh@0.1.2-rc.1', 'dsh', '--profile', 'sdk']
    if (contextPatchPath !== undefined) args.push('--patch', contextPatchPath)
    const launchCwd = options.dshBin
      ? options.cwd
      : this.contextPatchDirectory ?? options.cwd
    const hasMcpEnvironment = options.mcpServers.some((server) => Object.keys(server.env).length > 0)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HELIX_CONTROL_ENDPOINT: controlBridge.endpoint,
      HELIX_CONTROL_TOKEN: controlBridge.token,
      DSH_PERMISSION_MODE: options.sandboxMode,
    }
    if (options.dshHome !== undefined) env.DSH_HOME = options.dshHome
    if (options.apiKey !== undefined) env.DEEPSEEK_API_KEY = options.apiKey
    if (options.baseUrl !== undefined) env.DEEPSEEK_BASE_URL = options.baseUrl
    if (hasMcpEnvironment) {
      for (const server of options.mcpServers) {
        for (const [environmentName, value] of Object.entries(server.env)) {
          env[mcpEnvironmentVariable(server.serverName, environmentName)] = value
        }
      }
    }
    const clientOptions: HarnessClientOptions = {
      command,
      args,
      cwd: launchCwd,
      env,
    }
    let client: HarnessClient | undefined
    let subscription: ReturnType<HarnessClient['subscribe']> | undefined
    try {
      client = new HarnessClient(clientOptions)
      client.start()
      subscription = client.subscribe()

      this.client = client
      this.subscription = subscription
      void this.consume(subscription, generation)

      await client.initialize({
        cwd: options.cwd,
        provider: options.provider,
        model: options.model,
      })
      await controlBridge.waitForConnection()
      this.setState({ state: 'ready' })
    } catch (error) {
      if (client !== undefined && subscription !== undefined) {
        await this.stopClient(client, subscription)
      } else {
        await controlBridge.close()
        if (this.controlBroker === controlBridge) this.controlBroker = undefined
        await this.removeContextPatch()
      }
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ state: 'error', message })
      throw error
    }
  }

  async prompt(sessionId: string, contentBlocks: ContentBlock[]): Promise<string> {
    if (this.client === undefined) {
      throw new Error('Helix runtime is not running')
    }

    return this.client.prompt(sessionId, contentBlocks)
  }

  async cancelTurn(sessionId: string): Promise<void> {
    try {
      if (this.controlBroker === undefined) {
        throw new ControlBridgeError('The DSH control bridge is not connected.', 'BRIDGE_UNAVAILABLE')
      }
      await this.controlBroker.cancel(sessionId)
    } catch (error) {
      if (error instanceof ControlBridgeError && (
        error.code === 'BRIDGE_UNAVAILABLE' ||
        error.code === 'BRIDGE_TIMEOUT' ||
        error.code === 'BRIDGE_CLOSED'
      )) {
        await this.stop()
        return
      }
      throw error
    }
  }

  async resolveApproval(sessionId: string, requestId: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    if (this.controlBroker === undefined) {
      throw new ControlBridgeError('The DSH control bridge is not connected.', 'BRIDGE_UNAVAILABLE')
    }
    await this.controlBroker.resolveApproval(sessionId, requestId, outcome)
  }

  async steer(sessionId: string, text: string): Promise<void> {
    if (this.controlBroker === undefined) throw new ControlBridgeError('The DSH control bridge is not connected.', 'BRIDGE_UNAVAILABLE')
    await this.controlBroker.steer(sessionId, text)
  }

  async inject(sessionId: string, text: string): Promise<void> {
    if (this.controlBroker === undefined) throw new ControlBridgeError('The DSH control bridge is not connected.', 'BRIDGE_UNAVAILABLE')
    await this.controlBroker.inject(sessionId, text)
  }

  async setApprovalPolicy(sessionId: string, policy: 'ask' | 'never'): Promise<void> {
    if (this.controlBroker === undefined) throw new ControlBridgeError('The DSH control bridge is not connected.', 'BRIDGE_UNAVAILABLE')
    await this.controlBroker.setApprovalPolicy(sessionId, policy)
  }

  async setSandboxMode(sessionId: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<void> {
    if (this.controlBroker === undefined) throw new ControlBridgeError('The DSH control bridge is not connected.', 'BRIDGE_UNAVAILABLE')
    await this.controlBroker.setSandboxMode(sessionId, mode)
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
    const client = this.client
    const subscription = this.subscription
    if (client === undefined || subscription === undefined) {
      await this.controlBroker?.close()
      this.controlBroker = undefined
      this.setState({ state: 'stopped' })
      return
    }

    await this.stopClient(client, subscription)
    this.setState({ state: 'stopped' })
  }

  async dispose(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      this.router.clear()
      await this.stopInternal()
      this.stateListeners.clear()
    })
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    return this.lifecycleQueue.run(operation)
  }

  private async consume(
    subscription: { [Symbol.asyncIterator](): AsyncIterator<HarnessNotification> },
    generation: number,
  ): Promise<void> {
    try {
      for await (const notification of subscription) {
        if (generation !== this.generation) continue
        this.router.accept(notification)
      }
    } catch (error) {
      if (generation !== this.generation || this.state === 'stopped') return
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ state: 'error', message })
    }
  }

  private async stopClient(
    client: HarnessClient,
    subscription: ReturnType<HarnessClient['subscribe']>,
  ): Promise<void> {
    this.generation += 1
    subscription.close()
    try {
      await client.close()
    } finally {
      if (this.client === client) this.client = undefined
      if (this.subscription === subscription) this.subscription = undefined
      this.router.resetLineage()
      await this.controlBroker?.close()
      this.controlBroker = undefined
      await this.removeContextPatch()
    }
  }

  private async createContextPatch(options: RuntimeOptions): Promise<string | undefined> {
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
      this.contextPatchDirectory = directory
      return patchPath
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  private async removeContextPatch(): Promise<void> {
    const directory = this.contextPatchDirectory
    this.contextPatchDirectory = undefined
    if (directory === undefined) return
    await rm(directory, { recursive: true, force: true })
  }

  private setState(change: RuntimeStateChange): void {
    this.state = change.state
    for (const listener of this.stateListeners) listener(change)
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}
