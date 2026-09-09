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
import { builtInWebPatchLines, mcpEnvironmentVariable, mcpPatchLines } from './mcp.js'
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

  constructor(options: {
    onUnrouted?: (notification: HarnessNotification) => void
    onHandlerError?: (error: unknown, notification: HarnessNotification) => void
  } = {}) {
    this.router = new SessionNotificationRouter(options)
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

  async start(options: RuntimeOptions): Promise<void> {
    if (this.client !== undefined) return

    this.setState({ state: 'starting' })
    const generation = ++this.generation
    const contextPatchPath = await this.createContextPatch(options)
    const command = options.dshBin || (process.platform === 'win32' ? 'npx.cmd' : 'npx')
    const args = options.dshBin
      ? ['--profile', 'sdk']
      : ['--yes', '@deepseek-ai/dsh', '--profile', 'sdk']
    if (contextPatchPath !== undefined) args.push('--patch', contextPatchPath)
    const hasMcpEnvironment = options.mcpServers.some((server) => Object.keys(server.env).length > 0)
    const env = options.dshHome !== undefined || options.apiKey !== undefined || options.baseUrl !== undefined || hasMcpEnvironment
      ? { ...process.env }
      : undefined
    if (env !== undefined) {
      if (options.dshHome !== undefined) env.DSH_HOME = options.dshHome
      if (options.apiKey !== undefined) env.DEEPSEEK_API_KEY = options.apiKey
      if (options.baseUrl !== undefined) env.DEEPSEEK_BASE_URL = options.baseUrl
      for (const server of options.mcpServers) {
        for (const [environmentName, value] of Object.entries(server.env)) {
          env[mcpEnvironmentVariable(server.serverName, environmentName)] = value
        }
      }
    }
    const clientOptions: HarnessClientOptions = {
      command,
      args,
      cwd: options.cwd,
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
      this.setState({ state: 'ready' })
    } catch (error) {
      if (client !== undefined && subscription !== undefined) {
        await this.stopClient(client, subscription)
      } else {
        await this.removeContextPatch()
      }
      const message = error instanceof Error ? error.message : String(error)
      this.setState({ state: 'error', message })
      throw error
    }
  }

  async prompt(sessionId: string, contentBlocks: ContentBlock[]): Promise<string> {
    if (this.client === undefined) {
      throw new Error('DeepBlue runtime is not running')
    }

    return this.client.prompt(sessionId, contentBlocks)
  }

  async restart(options: RuntimeOptions): Promise<void> {
    await this.stop()
    await this.start(options)
  }

  async stop(): Promise<void> {
    const client = this.client
    const subscription = this.subscription
    if (client === undefined || subscription === undefined) {
      this.setState({ state: 'stopped' })
      return
    }

    await this.stopClient(client, subscription)
    this.setState({ state: 'stopped' })
  }

  async dispose(): Promise<void> {
    this.router.clear()
    await this.stop()
    this.stateListeners.clear()
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
    patchLines.push(...builtInWebPatchLines())
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
