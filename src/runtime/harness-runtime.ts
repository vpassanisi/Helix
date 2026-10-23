import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  HarnessClient,
  type ContentBlock,
  type HarnessClientOptions,
  type HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client'
import { resolveAdapterOptions, type DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
import {
  ControlBridgeError,
  LocalControlBridge,
  type ControlBroker,
  type ControlBridgeOptions,
  type ControlEvent,
} from './control-bridge.js'
import { builtInWebPatchLines, mcpEnvironmentVariable, mcpPatchLines } from './mcp.js'
import { pluginPatchLines } from './plugins.js'
import { toolBundlePatchLines } from '../shared/tool-bundles.js'
import { SerialTaskQueue } from './serial-task-queue.js'
import type { UserQuestionAnswer } from '../shared/user-question.js'
import { stringValue } from '../shared/value-utils.js'
import type { SkillCatalog, SkillTurnSelection } from '../shared/skills.js'
import type { CommandCatalog } from '../shared/commands.js'
import type { ControlCommandResult } from './control-protocol.js'
import { piAiRuntimeModelProfiles, type ChatTemplateValue } from './model-catalog.js'
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

interface DshRuntimeProcessOptions {
  command: string
  args: string[]
  cwd?: string
  environment: () => NodeJS.ProcessEnv
  description: string
  initializeTimeoutMs: number
}

const ELECTRON_DSH_LAUNCHER = `
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request !== 'node-addon-require-builtin') {
    return Reflect.apply(originalLoad, this, [request, parent, isMain])
  }

  const requireFromParent = createRequire(parent?.filename ?? import.meta.url)
  return {
    requireBuiltin: (moduleId) => requireFromParent(moduleId),
    isAllowedInternalId: () => true,
    getBindingInfo: () => ({ mode: 'expose-internals', product: 'require-builtin', backend: 'builtin' }),
  }
}

const [dshBin, ...dshArgs] = process.argv.slice(2)
if (dshBin === undefined) throw new Error('Helix DSH launcher requires a DSH entrypoint.')
process.argv = [process.argv[0], dshBin, ...dshArgs]
const { runCli } = await import(pathToFileURL(dshBin).href)
await runCli()
`

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
      contextPatch = await this.createContextPatch(options)
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

  async waitForSession(sessionId: string): Promise<void> {
    const handle = this.requireHandle()
    try {
      await handle.client.request('session/wait', { sessionId })
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

  private async createContextPatch(options: RuntimeOptions): Promise<ContextPatch | undefined> {
    const contextWindow = options.contextWindow
    const hasContextWindow = contextWindow !== undefined && Number.isSafeInteger(contextWindow) && contextWindow > 0

    const directory = await mkdtemp(join(tmpdir(), 'dsh-vscode-'))
    const patchPath = join(directory, 'runtime.patch.yml')
    const patchLines: string[] = []
    if (options.provider === 'deepseek-official' && (hasContextWindow || (options.savedModels?.length ?? 0) > 0)) {
      const catalog: DeepSeekCatalogModel[] = resolveAdapterOptions({}).models.map((model) => ({ ...model }))
      for (const saved of options.savedModels ?? []) {
        const existing = catalog.find((model) => model.id === saved.id)
        const model: DeepSeekCatalogModel = existing ?? { id: saved.id }
        if (existing === undefined) catalog.push(model)
        if (saved.displayName !== undefined) model.name = saved.displayName
        if (saved.contextWindow !== undefined) model.contextWindow = saved.contextWindow
        model.inputModalities = saved.acceptsImages === true ? ['text', 'image'] : ['text']
        if (saved.acceptsImages !== true) {
          model.imagePixelBudget = undefined
          model.imageMaxBytes = undefined
        }
      }
      if (hasContextWindow) {
        const active = catalog.find((model) => model.id === options.model)
        if (active !== undefined) active.contextWindow = contextWindow
        else catalog.push({ id: options.model, contextWindow })
      }
      patchLines.push('- id: llm-deepseek', '  config:')
      if (hasContextWindow) patchLines.push(`    defaultContextWindow: ${contextWindow}`)
      patchLines.push('    models:')
      for (const model of catalog) patchLines.push(...directDeepSeekModelYamlLines(model))
    } else if (hasContextWindow) {
      patchLines.push(
        '- id: llm-deepseek',
        '  config:',
        `    defaultContextWindow: ${contextWindow}`,
        '    models:',
        `      - id: ${yamlString(options.model)}`,
        `        contextWindow: ${contextWindow}`,
      )
    }
    if (options.provider !== 'deepseek-official') {
      const modelProfiles = piAiRuntimeModelProfiles(options.savedModels ?? [])
      if (hasContextWindow || modelProfiles.length > 0) {
        patchLines.push(
          '- id: llm-pi-ai',
          '  config:',
          '    providers:',
          `      ${yamlString(options.provider)}:`,
          '        api: openai-completions',
          '        apiKeyEnv: DEEPSEEK_API_KEY',
          '        baseURL: !!js process.env.DEEPSEEK_BASE_URL',
        )
        if (modelProfiles.length > 0) {
          patchLines.push('        models:')
          for (const profile of modelProfiles) {
            patchLines.push(`          - id: ${yamlString(profile.id)}`)
            if (profile.name !== undefined) patchLines.push(`            name: ${yamlString(profile.name)}`)
            if (profile.contextWindow !== undefined) patchLines.push(`            contextWindow: ${profile.contextWindow}`)
            patchLines.push(`            input: [${profile.input.map(yamlString).join(', ')}]`)
            if (profile.reasoningEfforts === false) {
              patchLines.push('            reasoningEfforts: false')
            } else if (profile.reasoningEfforts !== undefined) {
              patchLines.push('            reasoningEfforts:')
              for (const [level, wireValue] of Object.entries(profile.reasoningEfforts)) {
                patchLines.push(`              ${yamlString(level)}: ${wireValue === null ? 'null' : yamlString(wireValue)}`)
              }
            }
            if (profile.compat !== undefined) {
              patchLines.push('            compat:')
              if (profile.compat.thinkingFormat !== undefined) {
                patchLines.push(`              thinkingFormat: ${yamlString(profile.compat.thinkingFormat)}`)
              }
              if (profile.compat.supportsReasoningEffort !== undefined) {
                patchLines.push(`              supportsReasoningEffort: ${profile.compat.supportsReasoningEffort}`)
              }
              if (profile.compat.chatTemplateKwargs !== undefined) {
                patchLines.push('              chatTemplateKwargs:')
                patchLines.push(...chatTemplateYamlLines(profile.compat.chatTemplateKwargs, 16))
              }
              if (profile.compat.chatTemplateArgs !== undefined) {
                patchLines.push('              chatTemplateArgs:')
                patchLines.push(...chatTemplateYamlLines(profile.compat.chatTemplateArgs, 16))
              }
            }
          }
        } else if (hasContextWindow) {
          patchLines.push(
            `        defaultContextWindow: ${contextWindow}`,
            '        models:',
            `          - id: ${yamlString(options.model)}`,
            `            contextWindow: ${contextWindow}`,
          )
        }
      }
    }
    patchLines.push(
      '- insert:',
      '    - id: helix-control-bridge',
      `      name: ${yamlString(new URL('./dsh-control-plugin.js', import.meta.url).href)}`,
      '      config:',
      `        cwd: ${yamlString(options.cwd)}`,
      '    - id: helix-question-tool',
      `      name: ${yamlString(new URL('./dsh-question-tool-plugin.js', import.meta.url).href)}`,
    )
    patchLines.push(...pluginPatchLines(options.plugins ?? []))
    if (options.sessionStorageRoot !== undefined) {
      patchLines.push(
        '- id: sessions',
        '  config:',
        `    root: ${yamlString(options.sessionStorageRoot)}`,
      )
    }
    patchLines.push(...builtInWebPatchLines())
    patchLines.push(...toolBundlePatchLines(options.disabledToolBundles ?? []))
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

function createElectronHarnessClient(
  options: HarnessClientOptions,
  launcherPath: string,
): HarnessClient {
  const callerCwd = process.cwd()
  const dshBin = options.dshBin === undefined
    ? resolveBundledDshBin()
    : resolve(callerCwd, options.dshBin)
  const profile = options.profile ?? 'sdk'
  const patches = (options.patches ?? []).map((patch) => resolve(callerCwd, patch))
  const args = [
    '--expose-internals',
    launcherPath,
    dshBin,
    '--profile',
    profile,
    ...patches.flatMap((patch) => ['--patch', patch]),
  ]
  const dshHome = options.dshHome === undefined ? undefined : resolve(callerCwd, options.dshHome)
  const runtime: DshRuntimeProcessOptions = {
    command: process.execPath,
    args,
    ...(options.processCwd === undefined ? {} : { cwd: resolve(callerCwd, options.processCwd) }),
    environment: () => ({
      ...(options.env ?? process.env),
      ELECTRON_RUN_AS_NODE: '1',
      ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }),
    }),
    description: `dsh profile ${JSON.stringify(profile)}`,
    initializeTimeoutMs: options.initializeTimeoutMs ?? 10_000,
  }

  // rc.2's SDK client has a generic process-launch seam used by its own tests.
  // Its public constructor omits that seam, so keep this cast local to the
  // pinned rc.2 integration instead of changing the SDK's launch behavior.
  const ProcessHarnessClient = HarnessClient as unknown as new (
    clientOptions: HarnessClientOptions,
    processOptions: DshRuntimeProcessOptions,
  ) => HarnessClient
  return new ProcessHarnessClient(options, runtime)
}

function resolveBundledDshBin(): string {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: { dsh?: string } }
  const entry = manifest.bin?.dsh
  if (entry === undefined) throw new Error('The bundled DSH package does not declare its CLI entrypoint.')
  return resolve(dirname(manifestPath), entry)
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
  if (options.baseUrl !== undefined) env.DEEPSEEK_BASE_URL = runtimeBaseUrl(options.provider, options.baseUrl)
  for (const server of options.mcpServers) {
    for (const [environmentName, value] of Object.entries(server.env)) {
      env[mcpEnvironmentVariable(server.serverName, environmentName)] = value
    }
  }
  return env
}

function runtimeBaseUrl(provider: string, baseUrl: string): string {
  if (provider !== 'deepseek-official') return baseUrl
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  if (url.hostname === 'api.deepseek.com' && (path === '' || path === '/v1')) {
    url.pathname = '/anthropic'
    return url.toString().replace(/\/$/, '')
  }
  return baseUrl
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function directDeepSeekModelYamlLines(model: DeepSeekCatalogModel): string[] {
  const lines = [`      - id: ${yamlString(model.id)}`]
  if (model.name !== undefined) lines.push(`        name: ${yamlString(model.name)}`)
  if (model.description !== undefined) lines.push(`        description: ${yamlString(model.description)}`)
  if (model.contextWindow !== undefined) lines.push(`        contextWindow: ${model.contextWindow}`)
  if (model.maxTokens !== undefined) lines.push(`        maxTokens: ${model.maxTokens}`)
  if (model.inputModalities !== undefined) {
    lines.push(`        inputModalities: [${model.inputModalities.map(yamlString).join(', ')}]`)
  }
  if (model.imagePixelBudget !== undefined) lines.push(`        imagePixelBudget: ${yamlScalar(model.imagePixelBudget)}`)
  if (model.imageMaxBytes !== undefined) lines.push(`        imageMaxBytes: ${model.imageMaxBytes}`)
  if (model.systemPromptUpdate !== undefined) lines.push(`        systemPromptUpdate: ${yamlString(model.systemPromptUpdate)}`)
  return lines
}

function chatTemplateYamlLines(values: Record<string, ChatTemplateValue>, indentation: number): string[] {
  const prefix = ' '.repeat(indentation)
  return Object.entries(values).flatMap(([key, value]) => {
    const keyLine = `${prefix}${yamlString(key)}:`
    if (typeof value === 'object' && value !== null) {
      return [
        keyLine,
        `${prefix}  $var: ${yamlString(value.$var)}`,
        ...(value.omitWhenOff === undefined ? [] : [`${prefix}  omitWhenOff: ${value.omitWhenOff}`]),
      ]
    }
    return [`${keyLine} ${yamlScalar(value)}`]
  })
}

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return yamlString(value)
  return String(value)
}
