import * as vscode from 'vscode'
import { ControlBridgeError } from '../runtime/control-bridge.js'
import { mcpSecretKey } from '../runtime/mcp.js'
import { modelEndpointCandidates, parseModelCatalog, type DiscoveredModel } from '../runtime/model-catalog.js'
import { HarnessRuntime } from '../runtime/harness-runtime.js'
import { SerialTaskQueue } from '../runtime/serial-task-queue.js'
import type { PersistedMcpServer, RuntimeMcpServer, RuntimeOptions, RuntimeState, SandboxMode } from '../runtime/types.js'
import { isRecord } from '../shared/value-utils.js'
import {
  SidebarProvider,
  type SidebarMessage,
  type SidebarMcpServer,
  type SidebarMcpServerSetting,
  type SidebarModel,
  type SidebarSettings,
} from '../sidebar/sidebar-provider.js'

const API_KEY_SECRET = 'deepseekHarness.apiKey'
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const MCP_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function normalizeSandboxMode(value: unknown): SandboxMode {
  return value === 'read-only' || value === 'danger-full-access' ? value : 'workspace-write'
}

export interface SettingsControllerOptions {
  context: vscode.ExtensionContext
  runtime: HarnessRuntime
  sidebar: SidebarProvider
  getRuntimeState: () => RuntimeState
  getActiveSessionId: () => string
  onError: (error: unknown) => void
}

interface SettingsSnapshot {
  provider: string
  baseUrl: string
  sandboxMode: SandboxMode
  mcpServers: PersistedMcpServer[]
  apiKey: string | undefined
  secrets: Map<string, string | undefined>
}

export class SettingsController {
  private readonly queue = new SerialTaskQueue()

  constructor(private readonly options: SettingsControllerOptions) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.queue.run(operation)
  }

  async postSettings(): Promise<void> {
    this.options.sidebar.post({ type: 'settings', settings: await this.getSidebarSettings() })
  }

  async fetchModels(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const provider = configuration.get<string>('provider', 'deepseek-official').trim()
    const configuredBaseUrl = configuration.get<string>('baseUrl', '').trim()
    const baseUrl = configuredBaseUrl || (provider === 'deepseek-official' ? 'https://api.deepseek.com' : '')
    const endpoints = modelEndpointCandidates(baseUrl)

    if (endpoints.length === 0) {
      this.postModels([], 'Set an API base URL to discover available models.')
      return
    }

    const apiKey = await this.options.context.secrets.get(API_KEY_SECRET)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    let lastError = 'The models endpoint did not respond.'

    for (const endpoint of endpoints) {
      try {
        const models = await fetchModelEndpoint(endpoint, headers)
        await this.syncSelectedModelContext(models)
        this.postModels(models)
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    this.postModels([], `Could not fetch models. ${lastError}`)
  }

  async saveSettings(message: Extract<SidebarMessage, { type: 'saveSettings' }>): Promise<void> {
    try {
      const next = await this.prepareSettings(message)
      const previousServers = this.configuredMcpServers()
      await this.validateMcpSecretReferences(message.mcpServers)
      const snapshot = await this.createSnapshot(previousServers, next.mcpServers)

      try {
        await this.writeSettings(message, next.mcpServers)
      } catch (error) {
        await this.restoreSettings(snapshot).catch((rollbackError) => {
          throw new Error(`${formatError(error)} Rollback also failed: ${formatError(rollbackError)}`)
        })
        throw error
      }

      await this.restartAfterSettings(true)
    } catch (error) {
      this.options.onError(error)
    }
  }

  async selectModel(message: Extract<SidebarMessage, { type: 'selectModel' }>): Promise<void> {
    const model = message.model.trim()
    if (!model) return

    const contextWindow = message.contextWindow ?? 0
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 0) {
      this.options.onError('The selected model reported an invalid context window.')
      return
    }

    try {
      const configuration = vscode.workspace.getConfiguration()
      await configuration.update('deepseekHarness.model', model, vscode.ConfigurationTarget.Global)
      await configuration.update('deepseekHarness.contextWindow', contextWindow, vscode.ConfigurationTarget.Global)
      await this.restartAfterSettings(false)
    } catch (error) {
      this.options.onError(error)
    }
  }

  async setSandboxMode(message: Extract<SidebarMessage, { type: 'setSandboxMode' }>): Promise<void> {
    const mode = normalizeSandboxMode(message.sandboxMode)
    try {
      await vscode.workspace.getConfiguration().update(
        'deepseekHarness.sandboxMode',
        mode,
        vscode.ConfigurationTarget.Global,
      )

      if (this.options.getRuntimeState() === 'ready') {
        try {
          await this.options.runtime.setSandboxMode(this.options.getActiveSessionId(), mode)
        } catch (error) {
          if (!(error instanceof ControlBridgeError) || error.code !== 'SESSION_NOT_FOUND') throw error
          await this.options.runtime.restart(await this.runtimeOptions())
        }
      } else if (this.options.getRuntimeState() === 'starting') {
        await this.options.runtime.restart(await this.runtimeOptions())
      }

      await this.postSettings()
    } catch (error) {
      this.options.onError(error)
    }
  }

  async runtimeOptions(): Promise<RuntimeOptions> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
    const contextWindow = configuration.get<number>('contextWindow', 0)
    return {
      cwd: workspaceFolder?.uri.fsPath ?? vscode.env.appRoot,
      provider: configuration.get<string>('provider', 'deepseek-official'),
      model: configuration.get<string>('model', 'deepseek-v4-flash'),
      apiKey: await this.options.context.secrets.get(API_KEY_SECRET),
      baseUrl: configuration.get<string>('baseUrl', '') || undefined,
      contextWindow: contextWindow > 0 ? contextWindow : undefined,
      dshBin: configuration.get<string>('dshBin', '') || undefined,
      dshHome: configuration.get<string>('dshHome', '') || undefined,
      sandboxMode: normalizeSandboxMode(configuration.get<string>('sandboxMode', 'workspace-write')),
      mcpServers: await this.runtimeMcpServers(),
    }
  }

  async getSidebarSettings(): Promise<SidebarSettings> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    return {
      provider: configuration.get<string>('provider', 'deepseek-official'),
      model: configuration.get<string>('model', 'deepseek-v4-flash'),
      contextWindow: configuration.get<number>('contextWindow', 0),
      baseUrl: configuration.get<string>('baseUrl', ''),
      dshHome: configuration.get<string>('dshHome', ''),
      apiKeyConfigured: Boolean(await this.options.context.secrets.get(API_KEY_SECRET)),
      sandboxMode: normalizeSandboxMode(configuration.get<string>('sandboxMode', 'workspace-write')),
      mcpServers: await this.sidebarMcpServers(),
    }
  }

  private async prepareSettings(message: Extract<SidebarMessage, { type: 'saveSettings' }>): Promise<{
    provider: string
    baseUrl: string
    mcpServers: PersistedMcpServer[]
  }> {
    const provider = message.provider.trim()
    const baseUrl = message.baseUrl.trim()
    if (!provider) throw new Error('Provider route is required.')
    validateHttpUrl(baseUrl, 'API URL')
    return { provider, baseUrl, mcpServers: this.normalizeMcpServers(message.mcpServers) }
  }

  private async writeSettings(message: Extract<SidebarMessage, { type: 'saveSettings' }>, mcpServers: PersistedMcpServer[]): Promise<void> {
    const configuration = vscode.workspace.getConfiguration()
    await this.syncMcpSecrets(mcpServers, message.mcpServers)
    await configuration.update('deepseekHarness.provider', message.provider.trim(), vscode.ConfigurationTarget.Global)
    await configuration.update('deepseekHarness.baseUrl', message.baseUrl.trim(), vscode.ConfigurationTarget.Global)
    await configuration.update('deepseekHarness.sandboxMode', message.sandboxMode, vscode.ConfigurationTarget.Global)
    await configuration.update('deepseekHarness.mcpServers', mcpServers, vscode.ConfigurationTarget.Global)

    if (message.clearApiKey) await this.options.context.secrets.delete(API_KEY_SECRET)
    else if (message.apiKey?.trim()) await this.options.context.secrets.store(API_KEY_SECRET, message.apiKey.trim())
  }

  private async restartAfterSettings(refreshModels: boolean): Promise<void> {
    const settings = await this.getSidebarSettings().catch((error) => {
      this.options.onError(error)
      return undefined
    })
    if (settings !== undefined) this.options.sidebar.post({ type: 'settingsSaved', settings, restarting: true })

    if (refreshModels) {
      try {
        await this.fetchModels()
      } catch (error) {
        this.options.onError(error)
      }
    }

    try {
      const runtimeOptions = await this.runtimeOptions()
      if (this.options.getRuntimeState() === 'stopped') await this.options.runtime.start(runtimeOptions)
      else await this.options.runtime.restart(runtimeOptions)
    } catch (error) {
      this.options.onError(error)
    }
  }

  private async syncSelectedModelContext(models: SidebarModel[]): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const selectedModel = configuration.get<string>('model', '').trim()
    const selected = models.find((model) => model.id === selectedModel)
    if (selected === undefined) return

    const nextContextWindow = selected.contextWindow ?? 0
    const current = configuration.get<number>('contextWindow', 0)
    if (current === nextContextWindow) return
    await vscode.workspace.getConfiguration().update(
      'deepseekHarness.contextWindow',
      nextContextWindow,
      vscode.ConfigurationTarget.Global,
    )
  }

  private postModels(models: SidebarModel[], error?: string): void {
    this.options.sidebar.post({ type: 'models', models, error })
  }

  private configuredMcpServers(): PersistedMcpServer[] {
    const values = vscode.workspace.getConfiguration('deepseekHarness').get<unknown[]>('mcpServers', [])
    if (!Array.isArray(values)) return []
    return values.flatMap((value) => {
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
        const value = await this.options.context.secrets.get(mcpSecretKey(server.serverName, environmentName))
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
        configured: Boolean(await this.options.context.secrets.get(mcpSecretKey(server.serverName, name))),
      }))),
    })))
  }

  private normalizeMcpServers(servers: SidebarMcpServer[]): PersistedMcpServer[] {
    const seenServerNames = new Set<string>()
    return servers.map((server, index) => {
      const normalized = normalizeMcpServer(server, index)
      if (seenServerNames.has(normalized.serverName)) throw new Error(`MCP server name "${normalized.serverName}" is duplicated.`)
      seenServerNames.add(normalized.serverName)
      return normalized
    })
  }

  private async validateMcpSecretReferences(servers: SidebarMcpServer[]): Promise<void> {
    for (const server of servers) {
      for (const environment of server.env) {
        const name = environment.name.trim()
        if (!name || environment.value || !environment.configured) continue
        const savedValue = await this.options.context.secrets.get(mcpSecretKey(server.serverName.trim(), name))
        if (savedValue === undefined) {
          throw new Error(`Enter a new value for environment variable "${name}" in MCP server "${server.serverName.trim()}".`)
        }
      }
    }
  }

  private async syncMcpSecrets(nextServers: PersistedMcpServer[], submittedServers: SidebarMcpServer[]): Promise<void> {
    const previousServers = this.configuredMcpServers()
    const nextKeys = new Set(nextServers.flatMap((server) => server.envKeys.map((name) => `${server.serverName}\0${name}`)))
    for (const server of previousServers) {
      for (const name of server.envKeys) {
        if (!nextKeys.has(`${server.serverName}\0${name}`)) {
          await this.options.context.secrets.delete(mcpSecretKey(server.serverName, name))
        }
      }
    }
    for (const server of submittedServers) {
      for (const environment of server.env) {
        if (environment.name.trim() && environment.value) {
          await this.options.context.secrets.store(
            mcpSecretKey(server.serverName.trim(), environment.name.trim()),
            environment.value,
          )
        }
      }
    }
  }

  private async createSnapshot(previousServers: PersistedMcpServer[], nextServers: PersistedMcpServer[]): Promise<SettingsSnapshot> {
    const keys = new Set<string>([API_KEY_SECRET])
    for (const server of [...previousServers, ...nextServers]) {
      for (const name of server.envKeys) keys.add(mcpSecretKey(server.serverName, name))
    }
    const secrets = new Map<string, string | undefined>()
    for (const key of keys) secrets.set(key, await this.options.context.secrets.get(key))
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    return {
      provider: configuration.get<string>('provider', 'deepseek-official'),
      baseUrl: configuration.get<string>('baseUrl', ''),
      sandboxMode: normalizeSandboxMode(configuration.get<string>('sandboxMode', 'workspace-write')),
      mcpServers: previousServers,
      apiKey: secrets.get(API_KEY_SECRET),
      secrets,
    }
  }

  private async restoreSettings(snapshot: SettingsSnapshot): Promise<void> {
    const errors: unknown[] = []
    const configuration = vscode.workspace.getConfiguration()
    for (const [key, value] of [
      ['deepseekHarness.provider', snapshot.provider],
      ['deepseekHarness.baseUrl', snapshot.baseUrl],
      ['deepseekHarness.sandboxMode', snapshot.sandboxMode],
      ['deepseekHarness.mcpServers', snapshot.mcpServers],
    ] as const) {
      try {
        await configuration.update(key, value, vscode.ConfigurationTarget.Global)
      } catch (error) {
        errors.push(error)
      }
    }
    for (const [key, value] of snapshot.secrets) {
      try {
        if (value === undefined) await this.options.context.secrets.delete(key)
        else await this.options.context.secrets.store(key, value)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new Error(errors.map(formatError).join(' '))
  }
}

async function fetchModelEndpoint(endpoint: string, headers: Record<string, string>): Promise<DiscoveredModel[]> {
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}.`)
  return parseModelCatalog(await response.json())
}

function validateHttpUrl(value: string, label: string): void {
  if (!value) return
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${label} must use HTTP or HTTPS.`)
}

function normalizeMcpServer(server: SidebarMcpServer, index: number): PersistedMcpServer {
  const serverName = server.serverName.trim()
  if (!MCP_SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`MCP server ${index + 1} needs a name using only letters, numbers, hyphens, or underscores.`)
  }
  const args = server.args.filter((argument) => argument.length > 0)
  const command = server.command.trim()
  const url = server.url.trim()
  if (server.transport === 'stdio' && !command) throw new Error(`MCP server "${serverName}" needs a command.`)
  if (server.transport === 'streamable-http') {
    validateHttpUrl(url, `MCP server "${serverName}" URL`)
    if (!url) throw new Error(`MCP server "${serverName}" needs a URL.`)
  }

  const seenEnvironmentNames = new Set<string>()
  if (server.transport === 'streamable-http' && server.env.some((entry) => entry.name.trim())) {
    throw new Error(`Environment variables are currently supported for stdio MCP servers only. Remove them from "${serverName}".`)
  }
  const envKeys = server.env.flatMap((entry) => {
    const name = entry.name.trim()
    if (!name) return []
    if (!MCP_ENVIRONMENT_NAME_PATTERN.test(name)) throw new Error(`Environment variable "${name}" in MCP server "${serverName}" is invalid.`)
    if (seenEnvironmentNames.has(name)) throw new Error(`Environment variable "${name}" in MCP server "${serverName}" is duplicated.`)
    if (!entry.value && !entry.configured) throw new Error(`Enter a value for environment variable "${name}" in MCP server "${serverName}", or remove it.`)
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
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
