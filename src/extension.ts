import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { captureEditorContext, editorContextMetadata } from './runtime/editor-context.js'
import { HarnessRuntime } from './runtime/harness-runtime.js'
import { mcpSecretKey } from './runtime/mcp.js'
import { modelEndpointCandidates, parseModelCatalog } from './runtime/model-catalog.js'
import { buildPromptContent } from './runtime/prompt-context.js'
import type { PersistedMcpServer, RuntimeMcpServer, RuntimeOptions, RuntimeState } from './runtime/types.js'
import {
  SidebarProvider,
  type SidebarMessage,
  type SidebarMcpServer,
  type SidebarMcpServerSetting,
  type SidebarModel,
  type SidebarOutgoingMessage,
  type SidebarSettings,
  type SidebarState,
} from './sidebar/sidebar-provider.js'

const API_KEY_SECRET = 'deepseekHarness.apiKey'
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const MCP_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

class ExtensionApp {
  readonly sidebar: SidebarProvider
  private readonly runtime: HarnessRuntime
  private readonly subscriptions: vscode.Disposable[] = []
  private activeSessionId = randomUUID()
  private runtimeState: RuntimeState = 'stopped'
  private selection: SidebarState['selection']
  private readonly sessionRoutes = new Set<{ dispose(): void }>()
  private promptGeneration = 0
  private disposed = false

  constructor(private readonly context: vscode.ExtensionContext) {
    this.runtime = new HarnessRuntime({
      onUnrouted: () => undefined,
      onHandlerError: (error) => this.postError(error),
    })
    this.sidebar = new SidebarProvider(
      context.extensionUri,
      () => this.getSidebarState(),
      (message) => this.handleMessage(message),
      context.extensionMode === vscode.ExtensionMode.Development,
    )

    this.subscriptions.push(this.runtime.onStateChange(({ state, message }) => {
      this.runtimeState = state
      this.sidebar.post({ type: 'state', state: this.getSidebarState() })
      if (message !== undefined) this.sidebar.post({ type: 'error', message })
    }))
    this.registerSessionRoute(this.activeSessionId)
  }

  refreshSelection(): void {
    this.selection = editorContextMetadata(vscode.window.activeTextEditor)
    this.sidebar.post({ type: 'selection', selection: this.selection })
  }

  newSession(): void {
    this.activeSessionId = randomUUID()
    this.registerSessionRoute(this.activeSessionId)
    this.selection = editorContextMetadata(vscode.window.activeTextEditor)
    this.sidebar.post({ type: 'state', state: this.getSidebarState(), resetTranscript: true })
  }

  async submit(prompt: string, includeSelection: boolean): Promise<void> {
    const generation = ++this.promptGeneration
    const editor = includeSelection ? vscode.window.activeTextEditor : undefined
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const maxCharacters = configuration.get<number>('maxSelectionCharacters', 32_000)
    const editorContext = captureEditorContext(editor)
    const contentBlocks = buildPromptContent(prompt, editorContext, maxCharacters)

    try {
      if (this.runtimeState !== 'ready') await this.runtime.start(await this.runtimeOptions())
      if (generation !== this.promptGeneration) return
      await this.runtime.prompt(this.activeSessionId, contentBlocks)
      if (generation !== this.promptGeneration) return
      this.sidebar.post({ type: 'accepted', sessionId: this.activeSessionId })
    } catch (error) {
      if (generation === this.promptGeneration) this.postError(error)
    }
  }

  async stopRuntime(): Promise<void> {
    this.promptGeneration += 1
    try {
      await this.runtime.stop()
    } catch (error) {
      this.postError(error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
    for (const route of this.sessionRoutes) route.dispose()
    this.sessionRoutes.clear()
    this.sidebar.dispose()
  }

  async shutdown(): Promise<void> {
    this.dispose()
    await this.runtime.dispose()
  }

  private async handleMessage(message: SidebarMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.refreshSelection()
        await this.postSettings()
        await this.fetchModels()
        return
      case 'openSettings':
        await this.postSettings()
        await this.fetchModels()
        return
      case 'saveSettings':
        await this.saveSettings(message)
        return
      case 'refreshModels':
        await this.fetchModels()
        return
      case 'selectModel':
        await this.selectModel(message)
        return
      case 'submit':
        await this.submit(message.prompt, message.includeSelection)
        return
      case 'stopRuntime':
        await this.stopRuntime()
        return
      case 'newSession':
        this.newSession()
        return
    }
  }

  private registerSessionRoute(sessionId: string): void {
    const route = this.runtime.registerSession(sessionId, (routed) => {
      const message: SidebarOutgoingMessage = {
        type: 'notification',
        sessionId: routed.rootSessionId,
        notification: routed.notification,
      }
      this.sidebar.post(message)
    }, 'tree')
    this.sessionRoutes.add(route)
  }

  private async runtimeOptions(): Promise<RuntimeOptions> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    const contextWindow = configuration.get<number>('contextWindow', 0)
    return {
      cwd: workspaceFolder?.uri.fsPath ?? vscode.env.appRoot,
      provider: configuration.get<string>('provider', 'deepseek-official'),
      model: configuration.get<string>('model', 'deepseek-v4-flash'),
      apiKey: await this.context.secrets.get(API_KEY_SECRET),
      baseUrl: configuration.get<string>('baseUrl', '') || undefined,
      contextWindow: contextWindow > 0 ? contextWindow : undefined,
      dshBin: configuration.get<string>('dshBin', '') || undefined,
      dshHome: configuration.get<string>('dshHome', '') || undefined,
      mcpServers: await this.runtimeMcpServers(),
    }
  }

  private async postSettings(): Promise<void> {
    this.sidebar.post({ type: 'settings', settings: await this.getSidebarSettings() })
  }

  private async saveSettings(message: Extract<SidebarMessage, { type: 'saveSettings' }>): Promise<void> {
    const provider = message.provider.trim()
    const baseUrl = message.baseUrl.trim()
    if (!provider) {
      this.postError('Provider route is required.')
      return
    }
    if (baseUrl) {
      let parsed: URL
      try {
        parsed = new URL(baseUrl)
      } catch {
        this.postError('API URL must be a valid HTTP or HTTPS URL.')
        return
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        this.postError('API URL must use HTTP or HTTPS.')
        return
      }
    }

    const mcpServers = this.normalizeMcpServers(message.mcpServers)
    const previousMcpServers = this.configuredMcpServers()
    await this.validateMcpSecretReferences(message.mcpServers)
    await this.syncMcpSecrets(previousMcpServers, mcpServers, message.mcpServers)

    const configuration = vscode.workspace.getConfiguration()
    await configuration.update('deepseekHarness.provider', provider, vscode.ConfigurationTarget.Global)
    await configuration.update('deepseekHarness.baseUrl', baseUrl, vscode.ConfigurationTarget.Global)
    await configuration.update('deepseekHarness.mcpServers', mcpServers, vscode.ConfigurationTarget.Global)

    if (message.clearApiKey) {
      await this.context.secrets.delete(API_KEY_SECRET)
    } else if (message.apiKey?.trim()) {
      await this.context.secrets.store(API_KEY_SECRET, message.apiKey.trim())
    }

    const settings = await this.getSidebarSettings()
    this.sidebar.post({
      type: 'settingsSaved',
      settings,
      restarting: true,
    })

    // Resolve the selected model's context before the next DSH process starts.
    await this.fetchModels()

    try {
      if (this.runtimeState === 'stopped') {
        await this.runtime.start(await this.runtimeOptions())
      } else {
        await this.runtime.restart(await this.runtimeOptions())
      }
    } catch (error) {
      this.postError(error)
    }
  }

  private async selectModel(message: Extract<SidebarMessage, { type: 'selectModel' }>): Promise<void> {
    const model = message.model.trim()
    if (!model) return

    const contextWindow = message.contextWindow ?? 0
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 0) {
      this.postError('The selected model reported an invalid context window.')
      return
    }

    const configuration = vscode.workspace.getConfiguration()
    await configuration.update('deepseekHarness.model', model, vscode.ConfigurationTarget.Global)
    await configuration.update('deepseekHarness.contextWindow', contextWindow, vscode.ConfigurationTarget.Global)

    this.sidebar.post({
      type: 'settingsSaved',
      settings: await this.getSidebarSettings(),
      restarting: true,
    })

    try {
      if (this.runtimeState === 'stopped') {
        await this.runtime.start(await this.runtimeOptions())
      } else {
        await this.runtime.restart(await this.runtimeOptions())
      }
    } catch (error) {
      this.postError(error)
    }
  }

  private async fetchModels(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const provider = configuration.get<string>('provider', 'deepseek-official').trim()
    const configuredBaseUrl = configuration.get<string>('baseUrl', '').trim()
    const baseUrl = configuredBaseUrl || (provider === 'deepseek-official' ? 'https://api.deepseek.com' : '')
    const endpoints = modelEndpointCandidates(baseUrl)

    if (endpoints.length === 0) {
      this.postModels([], 'Set an API base URL to discover available models.')
      return
    }

    const apiKey = await this.context.secrets.get(API_KEY_SECRET)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    let lastError = 'The models endpoint did not respond.'

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          headers,
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) {
          lastError = `${endpoint} returned HTTP ${response.status}.`
          continue
        }

        const payload: unknown = await response.json()
        const models = parseModelCatalog(payload)
        try {
          await this.syncSelectedModelContext(models)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.postModels([], `Models loaded, but the selected model context could not be saved. ${message}`)
          return
        }
        this.postModels(models)
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    this.postModels([], `Could not fetch models. ${lastError}`)
  }

  private async syncSelectedModelContext(models: SidebarModel[]): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const selectedModel = configuration.get<string>('model', '').trim()
    const selected = models.find((model) => model.id === selectedModel)
    if (selected?.contextWindow === undefined) return

    const current = configuration.get<number>('contextWindow', 0)
    if (current === selected.contextWindow) return
    await vscode.workspace.getConfiguration().update(
      'deepseekHarness.contextWindow',
      selected.contextWindow,
      vscode.ConfigurationTarget.Global,
    )
  }

  private postModels(models: SidebarModel[], error?: string): void {
    this.sidebar.post({ type: 'models', models, error })
  }

  private async getSidebarSettings(): Promise<SidebarSettings> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    return {
      provider: configuration.get<string>('provider', 'deepseek-official'),
      model: configuration.get<string>('model', 'deepseek-v4-flash'),
      contextWindow: configuration.get<number>('contextWindow', 0),
      baseUrl: configuration.get<string>('baseUrl', ''),
      dshHome: configuration.get<string>('dshHome', ''),
      apiKeyConfigured: Boolean(await this.context.secrets.get(API_KEY_SECRET)),
      mcpServers: await this.sidebarMcpServers(),
    }
  }

  private configuredMcpServers(): PersistedMcpServer[] {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const configured = configuration.get<unknown[]>('mcpServers', [])
    if (!Array.isArray(configured)) return []

    return configured.flatMap((value) => {
      if (!isRecord(value) || typeof value.serverName !== 'string' ||
        (value.transport !== 'stdio' && value.transport !== 'streamable-http') ||
        !Array.isArray(value.args) || !value.args.every((argument) => typeof argument === 'string') ||
        !Array.isArray(value.envKeys) || !value.envKeys.every((key) => typeof key === 'string')) return []

      return [{
        serverName: value.serverName,
        transport: value.transport,
        command: typeof value.command === 'string' ? value.command : undefined,
        args: value.args,
        url: typeof value.url === 'string' ? value.url : undefined,
        envKeys: value.envKeys,
      } satisfies PersistedMcpServer]
    })
  }

  private async runtimeMcpServers(): Promise<RuntimeMcpServer[]> {
    return Promise.all(this.configuredMcpServers().map(async (server) => {
      const entries = await Promise.all(server.envKeys.map(async (environmentName) => {
        const value = await this.context.secrets.get(mcpSecretKey(server.serverName, environmentName))
        return value === undefined ? undefined : [environmentName, value] as const
      }))

      return {
        serverName: server.serverName,
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: server.url,
        env: Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== undefined)),
      }
    }))
  }

  private async sidebarMcpServers(): Promise<SidebarMcpServerSetting[]> {
    return Promise.all(this.configuredMcpServers().map(async (server) => ({
      serverName: server.serverName,
      transport: server.transport,
      command: server.command ?? '',
      args: server.args,
      url: server.url ?? '',
      env: await Promise.all(server.envKeys.map(async (name) => ({
        name,
        configured: Boolean(await this.context.secrets.get(mcpSecretKey(server.serverName, name))),
      }))),
    })))
  }

  private normalizeMcpServers(servers: SidebarMcpServer[]): PersistedMcpServer[] {
    const seenServerNames = new Set<string>()
    return servers.map((server, index) => {
      const serverName = server.serverName.trim()
      if (!MCP_SERVER_NAME_PATTERN.test(serverName)) {
        throw new Error(`MCP server ${index + 1} needs a name using only letters, numbers, hyphens, or underscores.`)
      }
      if (seenServerNames.has(serverName)) throw new Error(`MCP server name "${serverName}" is duplicated.`)
      seenServerNames.add(serverName)

      const args = server.args.map((argument) => argument).filter((argument) => argument.length > 0)
      const command = server.command.trim()
      const url = server.url.trim()
      if (server.transport === 'stdio' && !command) throw new Error(`MCP server "${serverName}" needs a command.`)
      if (server.transport === 'streamable-http') {
        if (!url) throw new Error(`MCP server "${serverName}" needs a URL.`)
        let parsedUrl: URL
        try {
          parsedUrl = new URL(url)
        } catch {
          throw new Error(`MCP server "${serverName}" needs a valid HTTP or HTTPS URL.`)
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new Error(`MCP server "${serverName}" needs an HTTP or HTTPS URL.`)
        }
      }

      const seenEnvironmentNames = new Set<string>()
      if (server.transport === 'streamable-http' && server.env.some((entry) => entry.name.trim())) {
        throw new Error(`Environment variables are currently supported for stdio MCP servers only. Remove them from "${serverName}".`)
      }
      const envKeys = server.env.flatMap((entry) => {
        const name = entry.name.trim()
        if (!name) return []
        if (!MCP_ENVIRONMENT_NAME_PATTERN.test(name)) {
          throw new Error(`Environment variable "${name}" in MCP server "${serverName}" is invalid.`)
        }
        if (seenEnvironmentNames.has(name)) throw new Error(`Environment variable "${name}" in MCP server "${serverName}" is duplicated.`)
        if (!entry.value && !entry.configured) {
          throw new Error(`Enter a value for environment variable "${name}" in MCP server "${serverName}", or remove it.`)
        }
        seenEnvironmentNames.add(name)
        return [name]
      })

      return {
        serverName,
        transport: server.transport,
        command: server.transport === 'stdio' ? command : undefined,
        args,
        url: server.transport === 'streamable-http' ? url : undefined,
        envKeys,
      }
    })
  }

  private async syncMcpSecrets(
    previousServers: PersistedMcpServer[],
    nextServers: PersistedMcpServer[],
    submittedServers: SidebarMcpServer[],
  ): Promise<void> {
    const nextKeys = new Set(nextServers.flatMap((server) => server.envKeys.map((name) => `${server.serverName}\0${name}`)))
    for (const server of previousServers) {
      for (const name of server.envKeys) {
        if (!nextKeys.has(`${server.serverName}\0${name}`)) {
          await this.context.secrets.delete(mcpSecretKey(server.serverName, name))
        }
      }
    }

    for (const server of submittedServers) {
      for (const environment of server.env) {
        if (environment.name.trim() && environment.value) {
          await this.context.secrets.store(
            mcpSecretKey(server.serverName.trim(), environment.name.trim()),
            environment.value,
          )
        }
      }
    }
  }

  private async validateMcpSecretReferences(servers: SidebarMcpServer[]): Promise<void> {
    for (const server of servers) {
      for (const environment of server.env) {
        const name = environment.name.trim()
        if (!name || environment.value || !environment.configured) continue
        const savedValue = await this.context.secrets.get(mcpSecretKey(server.serverName.trim(), name))
        if (savedValue === undefined) {
          throw new Error(`Enter a new value for environment variable "${name}" in MCP server "${server.serverName.trim()}".`)
        }
      }
    }
  }

  private getSidebarState(): SidebarState {
    return {
      activeSessionId: this.activeSessionId,
      runtimeState: this.runtimeState,
      selection: this.selection,
    }
  }

  private postError(error: unknown): void {
    this.sidebar.post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

let activeApp: ExtensionApp | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function activate(context: vscode.ExtensionContext): void {
  const app = new ExtensionApp(context)
  activeApp = app
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dsh.sidebar', app.sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.openSidebar', () => vscode.commands.executeCommand('workbench.view.extension.dsh')),
    vscode.commands.registerCommand('dsh.newSession', () => app.newSession()),
    vscode.commands.registerCommand('dsh.askSelection', async () => {
      await vscode.commands.executeCommand('dsh.openSidebar')
      app.refreshSelection()
    }),
    vscode.window.onDidChangeTextEditorSelection(() => app.refreshSelection()),
    vscode.window.onDidChangeActiveTextEditor(() => app.refreshSelection()),
  )
}

export async function deactivate(): Promise<void> {
  const app = activeApp
  activeApp = undefined
  if (app !== undefined) await app.shutdown()
}
