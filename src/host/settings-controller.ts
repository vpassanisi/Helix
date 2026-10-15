import { DEFAULT_DECISION_SETTINGS, decisionEndpoint, type DecisionSettings } from '../shared/skills.js'
import type { DecisionConnection } from './decision-client.js'
import * as vscode from 'vscode'
import { ControlBridgeError } from '../runtime/control-bridge.js'
import { mcpSecretKey } from '../runtime/mcp.js'
import { configuredPluginBundles, createOtelTracingPlugin } from '../runtime/plugins.js'
import {
  activeSelectionAfterCatalogSave,
  modelEndpointCandidates,
  normalizeModelDrafts,
  parseModelCatalog,
  parseSavedModelCatalogJsonWithLegacy,
  reconcileReasoningEffortHistory,
  resolveSavedModelReasoningEffort,
  selectableReasoningEfforts,
  seedReasoningEffortHistory,
  selectionForSavedModel,
  serializeSavedModelCatalog,
  validateModelDraftSources,
  type DiscoveredModel,
  type SavedModel,
} from '../runtime/model-catalog.js'
import { HarnessRuntime } from '../runtime/harness-runtime.js'
import { SerialTaskQueue } from '../runtime/serial-task-queue.js'
import type { PersistedMcpServer, RuntimeMcpServer, RuntimeOptions, RuntimeState, SandboxMode } from '../runtime/types.js'
import { isRecord } from '../shared/value-utils.js'
import {
  isValidOtelEndpointId,
  isValidOtelHeaderName,
  normalizeOtelTracingSettings,
  persistedOtelTracingSettings,
  type OtelTracingSettings,
} from '../shared/otel-tracing.js'
import {
  SidebarProvider,
  type SidebarMessage,
  type SidebarMcpServer,
  type SidebarMcpServerSetting,
  type SidebarSettings,
} from '../sidebar/sidebar-provider.js'

const API_KEY_SECRET = 'deepseekHarness.apiKey'
const DECISIONS_KEY_SECRET = 'deepseekHarness.decisionsApiKey'
const OTEL_SECRET_PREFIX = 'deepseekHarness.otelTracing.endpoint.'
const MODEL_CATALOG_FILE = 'models.json'
const REASONING_HISTORY_KEY = 'helix.lastUsedReasoningEfforts'
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const MCP_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function otelEndpointSecretKey(id: string): string {
  return `${OTEL_SECRET_PREFIX}${id}.credential`
}

function resolveLegacyHeaders(environmentName: string | undefined): Record<string, string> {
  const name = environmentName?.trim()
  if (!name) return {}
  const raw = process.env[name]?.trim()
  if (!raw) throw new Error(`Environment variable ${name} is required for the existing OTLP destination.`)
  const headers: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const separator = pair.indexOf('=')
    if (separator <= 0) throw new Error(`Invalid headers in environment variable ${name}; expected comma-separated key=value pairs.`)
    const headerName = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!isValidOtelHeaderName(headerName) || /[\r\n]/.test(value)) {
      throw new Error(`Invalid header in environment variable ${name}.`)
    }
    headers[headerName] = value
  }
  return headers
}

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
  decisions: DecisionSettings
  provider: string
  baseUrl: string
  sandboxMode: SandboxMode
  tracing: OtelTracingSettings
  mcpServers: PersistedMcpServer[]
  apiKey: string | undefined
  secrets: Map<string, string | undefined>
}

export class SettingsController {
  private readonly queue = new SerialTaskQueue()
  private catalogReadInFlight: Promise<SavedModel[]> | undefined
  private applyingTracingConfig = false
  private savingConnectionSettings = false

  constructor(private readonly options: SettingsControllerOptions) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.queue.run(operation)
  }

  isApplyingTracingConfig(): boolean {
    return this.applyingTracingConfig || this.savingConnectionSettings
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
      this.postDiscoveredModels([], 'Set an API base URL to discover available models.')
      return
    }

    const apiKey = await this.options.context.secrets.get(API_KEY_SECRET)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    let lastError = 'The models endpoint did not respond.'

    for (const endpoint of endpoints) {
      try {
        const models = await fetchModelEndpoint(endpoint, headers)
        this.postDiscoveredModels(models)
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    this.postDiscoveredModels([], `Could not fetch models. ${lastError}`)
  }

  async loadModelCatalog(): Promise<void> {
    try {
      this.postModelCatalog(await this.readModelCatalog())
    } catch (error) {
      this.postModelCatalog([], `Could not read the models file. ${formatError(error)}`)
    }
  }

  reasoningEffortHistory(): Record<string, string> {
    const stored = this.options.context.globalState.get<unknown>(REASONING_HISTORY_KEY)
    if (!isRecord(stored)) return {}
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] =>
      entry[0] !== '' && typeof entry[1] === 'string' && entry[1].trim() !== ''))
  }

  async resolveReasoningEffort(selection: string | null, modelId = vscode.workspace.getConfiguration('deepseekHarness').get<string>('model', 'deepseek-v4-flash')): Promise<string | undefined> {
    const models = await this.readModelCatalog()
    return resolveSavedModelReasoningEffort(models, modelId, selection, this.reasoningEffortHistory()[modelId])
  }

  async rememberReasoningEffort(modelId: string, effort: string | undefined): Promise<void> {
    if (effort === undefined) return
    const models = await this.readModelCatalog()
    const model = models.find((entry) => entry.id === modelId)
    if (!selectableReasoningEfforts(model).includes(effort)) return
    const history = this.reasoningEffortHistory()
    if (history[modelId] === effort) return
    await this.options.context.globalState.update(REASONING_HISTORY_KEY, { ...history, [modelId]: effort })
  }

  async saveModelCatalog(message: Extract<SidebarMessage, { type: 'saveModelCatalog' }>): Promise<void> {
    try {
      const previousModels = await this.readModelCatalog()
      const nextDrafts = normalizeModelDrafts(message.models)
      validateModelDraftSources(previousModels, nextDrafts)
      const nextModels = nextDrafts.map(({ sourceId: _sourceId, ...model }) => model)
      const previousHistory = this.reasoningEffortHistory()
      const nextHistory = reconcileReasoningEffortHistory(previousHistory, nextDrafts)
      const catalogChanged = JSON.stringify(previousModels) !== JSON.stringify(nextModels)
      const configuration = vscode.workspace.getConfiguration('deepseekHarness')
      const activeSelection = activeSelectionAfterCatalogSave(
        previousModels,
        nextDrafts,
        {
          model: configuration.get<string>('model', 'deepseek-v4-flash'),
          contextWindow: configuration.get<number>('contextWindow', 0),
        },
      )

      const historyChanged = JSON.stringify(previousHistory) !== JSON.stringify(nextHistory)
      if (historyChanged) await this.options.context.globalState.update(REASONING_HISTORY_KEY, nextHistory)
      try {
        await this.writeModelCatalog(nextModels)
      } catch (error) {
        if (historyChanged) await this.options.context.globalState.update(REASONING_HISTORY_KEY, previousHistory)
        throw error
      }

      if (activeSelection !== undefined) {
        const globalConfiguration = vscode.workspace.getConfiguration()
        await globalConfiguration.update('deepseekHarness.model', activeSelection.model, vscode.ConfigurationTarget.Global)
        await globalConfiguration.update('deepseekHarness.contextWindow', activeSelection.contextWindow, vscode.ConfigurationTarget.Global)
      }

      const runtimeRestarting = activeSelection !== undefined || catalogChanged
      this.options.sidebar.post({ type: 'modelCatalogSaved', models: nextModels, reasoningHistory: nextHistory, runtimeRestarting })
      if (runtimeRestarting) await this.restartAfterSettings(false)
    } catch (error) {
      this.options.onError(error)
    }
  }

  async saveSettings(message: Extract<SidebarMessage, { type: 'saveSettings' }>): Promise<void> {
    this.savingConnectionSettings = true
    try {
      this.prepareSettings(message)
      const nextTracing = message.tracing === undefined ? undefined : normalizeOtelTracingSettings(message.tracing)
      if (nextTracing !== undefined) await this.validateTracingSecrets(nextTracing)
      const previousServers = this.configuredMcpServers()
      const snapshot = await this.createSnapshot(previousServers, previousServers, nextTracing)

      try {
        await this.writeSettings(message, nextTracing)
      } catch (error) {
        await this.restoreSettings(snapshot).catch((rollbackError) => {
          throw new Error(`${formatError(error)} Rollback also failed: ${formatError(rollbackError)}`)
        })
        throw error
      }

      await this.restartAfterSettings(false)
    } catch (error) {
      this.options.onError(error)
    } finally {
      this.savingConnectionSettings = false
    }
  }

  async saveMcpServers(message: Extract<SidebarMessage, { type: 'saveMcpServers' }>): Promise<void> {
    try {
      const previousServers = this.configuredMcpServers()
      const nextServers = this.normalizeMcpServers(message.mcpServers)
      await this.validateMcpSecretReferences(message.mcpServers)
      const snapshot = await this.createSnapshot(previousServers, nextServers)

      try {
        await this.syncMcpSecrets(nextServers, message.mcpServers)
        await vscode.workspace.getConfiguration().update('deepseekHarness.mcpServers', nextServers, vscode.ConfigurationTarget.Global)
      } catch (error) {
        await this.restoreSettings(snapshot).catch((rollbackError) => {
          throw new Error(`${formatError(error)} Rollback also failed: ${formatError(rollbackError)}`)
        })
        throw error
      }

      await this.restartAfterSettings(false)
    } catch (error) {
      this.options.onError(error)
    }
  }

  async selectModel(message: Extract<SidebarMessage, { type: 'selectModel' }>): Promise<boolean> {
    const model = message.model.trim()
    if (!model) return false

    try {
      const savedSelection = selectionForSavedModel(await this.readModelCatalog(), model)

      const configuration = vscode.workspace.getConfiguration()
      await configuration.update('deepseekHarness.model', savedSelection.model, vscode.ConfigurationTarget.Global)
      await configuration.update('deepseekHarness.contextWindow', savedSelection.contextWindow, vscode.ConfigurationTarget.Global)
      await this.restartAfterSettings(false)
      return true
    } catch (error) {
      this.options.onError(error)
      return false
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
    const extensionPath = this.options.context.extensionPath || process.cwd()
    const contextWindow = configuration.get<number>('contextWindow', 0)
    return {
      cwd: workspaceFolder?.uri.fsPath ?? vscode.env.appRoot,
      provider: configuration.get<string>('provider', 'deepseek-official'),
      model: configuration.get<string>('model', 'deepseek-v4-flash'),
      apiKey: await this.options.context.secrets.get(API_KEY_SECRET),
      baseUrl: configuration.get<string>('baseUrl', '') || undefined,
      contextWindow: contextWindow > 0 ? contextWindow : undefined,
      savedModels: await this.readModelCatalog(),
      dshBin: configuration.get<string>('dshBin', '') || undefined,
      dshHome: configuration.get<string>('dshHome', '') || undefined,
      plugins: [
        createOtelTracingPlugin(extensionPath, await this.runtimeTracingConfig()),
        ...configuredPluginBundles(configuration.get<unknown>('plugins', []), extensionPath),
      ],
      sandboxMode: normalizeSandboxMode(configuration.get<string>('sandboxMode', 'workspace-write')),
      mcpServers: await this.runtimeMcpServers(),
    }
  }

  async restartForPluginSettings(): Promise<void> {
    if (this.options.getRuntimeState() === 'stopped') return
    try {
      await this.options.runtime.restart(await this.runtimeOptions())
    } catch (error) {
      this.options.onError(error)
    }
  }

  skillPickerEnabled(): boolean {
    return vscode.workspace.getConfiguration('deepseekHarness').get<boolean>('experimentalSkillPicker', false) === true
  }

  async decisionConnection(): Promise<DecisionConnection> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const settings = this.readDecisionSettings()
    const baseUrl = settings.useMainConnection
      ? configuration.get<string>('baseUrl', '').trim() || (configuration.get<string>('provider', 'deepseek-official') === 'deepseek-official' ? 'https://api.deepseek.com' : '')
      : settings.baseUrl
    const threshold = configuration.get<number>('skillSelectionThreshold', 0.75)
    return { ...settings, enabled: this.skillPickerEnabled() && settings.enabled, baseUrl, apiKey: await this.options.context.secrets.get(settings.useMainConnection ? API_KEY_SECRET : DECISIONS_KEY_SECRET),
      threshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : 0.75 }
  }

  private readDecisionSettings(): DecisionSettings {
    const { enabled, useMainConnection, format, baseUrl, model } = {
      ...DEFAULT_DECISION_SETTINGS, ...vscode.workspace.getConfiguration('deepseekHarness').get<Partial<DecisionSettings>>('decisions', {}),
    }
    return { enabled, useMainConnection, format, baseUrl, model }
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
      skillPickerEnabled: this.skillPickerEnabled(),
      decisions: { ...this.readDecisionSettings(), apiKeyConfigured: Boolean(await this.options.context.secrets.get(DECISIONS_KEY_SECRET)) },
      sandboxMode: normalizeSandboxMode(configuration.get<string>('sandboxMode', 'workspace-write')),
      tracing: await this.sidebarTracingSettings(),
      mcpServers: await this.sidebarMcpServers(),
    }
  }

  private async sidebarTracingSettings(): Promise<OtelTracingSettings> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const tracing = normalizeOtelTracingSettings(configuration.get<unknown>('otelTracing', {}))
    return {
      ...tracing,
      endpoints: await Promise.all(tracing.endpoints.map(async (endpoint) => ({
        ...endpoint,
        credentialConfigured: (await this.options.context.secrets.get(otelEndpointSecretKey(endpoint.id))) !== undefined,
        credentialDraft: '',
        clearCredential: false,
      }))),
    }
  }

  private async runtimeTracingConfig(): Promise<Record<string, unknown>> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const tracing = normalizeOtelTracingSettings(configuration.get<unknown>('otelTracing', {}))
    const endpoints = await Promise.all(tracing.endpoints
      .filter((endpoint) => endpoint.url.trim())
      .map(async (endpoint) => {
        const headers = endpoint.authMethod === 'bearer' || endpoint.authMethod === 'api-key'
          ? this.tracingCredentialHeaders(endpoint, await this.options.context.secrets.get(otelEndpointSecretKey(endpoint.id)))
          : resolveLegacyHeaders(endpoint.legacyHeadersEnv)
        return {
          url: endpoint.url.trim(),
          protocol: endpoint.protocol,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          timeoutMs: endpoint.timeoutMs,
        }
      }))
    return {
      enabled: tracing.enabled,
      serviceName: tracing.serviceName.trim() || 'helix',
      endpoints,
      capturePrompts: tracing.capturePrompts,
      captureResponses: tracing.captureResponses,
      captureToolArguments: tracing.captureToolArguments,
      maxContentLength: tracing.maxContentLength,
    }
  }

  private tracingCredentialHeaders(endpoint: OtelTracingSettings['endpoints'][number], credential: string | undefined): Record<string, string> {
    if (!credential) return {}
    if (credential.includes('\r') || credential.includes('\n')) {
      throw new Error(`OTLP destination credential for ${endpoint.url} contains a line break.`)
    }
    return endpoint.authMethod === 'bearer'
      ? { authorization: `Bearer ${credential}` }
      : { [endpoint.headerName.trim() || 'x-api-key']: credential }
  }

  private async validateTracingSecrets(tracing: OtelTracingSettings): Promise<void> {
    if (!tracing.enabled) return
    for (const [index, endpoint] of tracing.endpoints.entries()) {
      if (endpoint.authMethod === 'none') continue
      if (endpoint.clearCredential && !endpoint.credentialDraft.trim()) {
        throw new Error(`OTLP destination ${index + 1} needs a credential for its selected authentication method.`)
      }
      if (endpoint.credentialDraft.trim()) continue
      const saved = await this.options.context.secrets.get(otelEndpointSecretKey(endpoint.id))
      if (saved === undefined) {
        throw new Error(`Enter a credential for OTLP destination ${index + 1}, or choose no authentication.`)
      }
    }
  }

  private async syncTracingSecrets(tracing: OtelTracingSettings): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const previous = normalizeOtelTracingSettings(configuration.get<unknown>('otelTracing', {}))
    const nextById = new Map(tracing.endpoints.map((endpoint) => [endpoint.id, endpoint]))
    const deletedCredentials = new Set<string>()
    for (const endpoint of previous.endpoints) {
      const next = nextById.get(endpoint.id)
      if ((next === undefined || next.authMethod === 'none') && endpoint.authMethod !== 'none') {
        await this.options.context.secrets.delete(otelEndpointSecretKey(endpoint.id))
        deletedCredentials.add(endpoint.id)
      }
    }
    for (const endpoint of tracing.endpoints) {
      const key = otelEndpointSecretKey(endpoint.id)
      if (endpoint.authMethod === 'none' || endpoint.clearCredential) {
        if ((endpoint.credentialConfigured || endpoint.clearCredential) && !deletedCredentials.has(endpoint.id)) {
          await this.options.context.secrets.delete(key)
        }
      } else if (endpoint.credentialDraft.trim()) {
        await this.options.context.secrets.store(key, endpoint.credentialDraft.trim())
      }
    }
  }

  private prepareSettings(message: Extract<SidebarMessage, { type: 'saveSettings' }>): void {
    const provider = message.provider.trim()
    const baseUrl = message.baseUrl.trim()
    if (!provider) throw new Error('Provider route is required.')
    validateHttpUrl(baseUrl, 'API URL')
    const decisions = this.skillPickerEnabled() ? message.decisions : undefined
    if (decisions?.enabled) {
      if (!decisions.model.trim()) throw new Error('Decisions model ID is required.')
      const url = decisions.useMainConnection ? baseUrl || (provider === 'deepseek-official' ? 'https://api.deepseek.com' : '') : decisions.baseUrl.trim()
      if (!url) throw new Error('An explicit API base URL is required for decisions.')
      decisionEndpoint(url, decisions.format)
    }
    const tracing = message.tracing
    if (tracing === undefined) return
    if (tracing.enabled && tracing.endpoints.length === 0) {
      throw new Error('Add at least one OTLP destination before enabling trace export.')
    }
    const endpointIds = new Set<string>()
    for (const [index, endpoint] of tracing.endpoints.entries()) {
      if (!isValidOtelEndpointId(endpoint.id)) throw new Error(`OTLP destination ${index + 1} has an invalid ID.`)
      if (endpointIds.has(endpoint.id)) throw new Error(`OTLP destination ${index + 1} has a duplicate ID.`)
      endpointIds.add(endpoint.id)
      if (endpoint.authMethod === 'api-key' && !isValidOtelHeaderName(endpoint.headerName.trim())) {
        throw new Error(`OTLP destination ${index + 1} needs a valid API key header name.`)
      }
      if (endpoint.credentialDraft.includes('\r') || endpoint.credentialDraft.includes('\n')) {
        throw new Error(`OTLP destination ${index + 1} credential cannot contain a line break.`)
      }
      const value = endpoint.url.trim()
      if (!value) {
        if (tracing.enabled) throw new Error(`OTLP destination ${index + 1} needs an endpoint.`)
        continue
      }
      if (endpoint.protocol === 'grpc') {
        validateGrpcTarget(value, index)
      } else {
        validateHttpUrl(value, `OTLP destination ${index + 1}`)
      }
      if (!Number.isInteger(endpoint.timeoutMs) || endpoint.timeoutMs < 100 || endpoint.timeoutMs > 120_000) {
        throw new Error(`OTLP destination ${index + 1} timeout must be between 100 and 120000 milliseconds.`)
      }
    }
  }

  private async writeSettings(message: Extract<SidebarMessage, { type: 'saveSettings' }>, tracing?: OtelTracingSettings): Promise<void> {
    const configuration = vscode.workspace.getConfiguration()
    await configuration.update('deepseekHarness.provider', message.provider.trim(), vscode.ConfigurationTarget.Global)
    await configuration.update('deepseekHarness.baseUrl', message.baseUrl.trim(), vscode.ConfigurationTarget.Global)
    await configuration.update('deepseekHarness.sandboxMode', message.sandboxMode, vscode.ConfigurationTarget.Global)
    if (tracing !== undefined) {
      this.applyingTracingConfig = true
      try {
        await this.syncTracingSecrets(tracing)
        await configuration.update('deepseekHarness.otelTracing', persistedOtelTracingSettings({
          ...tracing,
          serviceName: tracing.serviceName.trim() || 'helix',
        }), vscode.ConfigurationTarget.Global)
      } finally {
        this.applyingTracingConfig = false
      }
    }

    if (this.skillPickerEnabled() && message.decisions) {
      const { enabled, useMainConnection, format, baseUrl, model } = message.decisions
      await configuration.update('deepseekHarness.decisions', { enabled, useMainConnection, format, baseUrl: baseUrl.trim(), model: model.trim() }, vscode.ConfigurationTarget.Global)
    }
    if (this.skillPickerEnabled()) {
      if (message.clearDecisionsApiKey) await this.options.context.secrets.delete(DECISIONS_KEY_SECRET)
      else if (message.decisionsApiKey?.trim()) await this.options.context.secrets.store(DECISIONS_KEY_SECRET, message.decisionsApiKey.trim())
    }
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

  private postDiscoveredModels(models: DiscoveredModel[], error?: string): void {
    this.options.sidebar.post({ type: 'discoveredModels', models, error })
  }

  private postModelCatalog(models: SavedModel[], error?: string): void {
    this.options.sidebar.post({ type: 'modelCatalog', models, reasoningHistory: this.reasoningEffortHistory(), error })
  }

  private async readModelCatalog(): Promise<SavedModel[]> {
    if (this.catalogReadInFlight !== undefined) return this.catalogReadInFlight
    const read = this.readModelCatalogOnce()
    this.catalogReadInFlight = read
    try {
      return await read
    } finally {
      if (this.catalogReadInFlight === read) this.catalogReadInFlight = undefined
    }
  }

  private async readModelCatalogOnce(): Promise<SavedModel[]> {
    const uri = vscode.Uri.joinPath(this.options.context.globalStorageUri, MODEL_CATALOG_FILE)
    let contents: Uint8Array
    try {
      contents = await vscode.workspace.fs.readFile(uri)
    } catch (error) {
      if (isFileNotFoundError(error)) return []
      throw error
    }

    const { models, legacyDefaults, needsMigration } = parseSavedModelCatalogJsonWithLegacy(new TextDecoder().decode(contents))
    if (needsMigration) {
      const history = this.reasoningEffortHistory()
      const migrated = seedReasoningEffortHistory(history, legacyDefaults)
      if (JSON.stringify(history) !== JSON.stringify(migrated)) {
        await this.options.context.globalState.update(REASONING_HISTORY_KEY, migrated)
      }
      await this.writeModelCatalog(models)
    }
    return models
  }

  private async writeModelCatalog(models: SavedModel[]): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.options.context.globalStorageUri)
    const uri = vscode.Uri.joinPath(this.options.context.globalStorageUri, MODEL_CATALOG_FILE)
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeSavedModelCatalog(models)))
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

  private async createSnapshot(previousServers: PersistedMcpServer[], nextServers: PersistedMcpServer[], nextTracing?: OtelTracingSettings): Promise<SettingsSnapshot> {
    const keys = new Set<string>([API_KEY_SECRET, DECISIONS_KEY_SECRET])
    for (const server of [...previousServers, ...nextServers]) {
      for (const name of server.envKeys) keys.add(mcpSecretKey(server.serverName, name))
    }
    const configuration = vscode.workspace.getConfiguration('deepseekHarness')
    const previousTracing = normalizeOtelTracingSettings(configuration.get<unknown>('otelTracing', {}))
    const previousTracingIds = new Set(previousTracing.endpoints.map((endpoint) => endpoint.id))
    for (const endpoint of previousTracing.endpoints) {
      if (endpoint.authMethod !== 'none') keys.add(otelEndpointSecretKey(endpoint.id))
    }
    const secrets = new Map<string, string | undefined>()
    for (const key of keys) secrets.set(key, await this.options.context.secrets.get(key))
    for (const endpoint of nextTracing?.endpoints ?? []) {
      if (endpoint.authMethod === 'none' || previousTracingIds.has(endpoint.id)) continue
      const key = otelEndpointSecretKey(endpoint.id)
      if (endpoint.credentialDraft.trim()) secrets.set(key, undefined)
    }
    return {
      provider: configuration.get<string>('provider', 'deepseek-official'),
      baseUrl: configuration.get<string>('baseUrl', ''),
      decisions: this.readDecisionSettings(),
      sandboxMode: normalizeSandboxMode(configuration.get<string>('sandboxMode', 'workspace-write')),
      tracing: previousTracing,
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
      ['deepseekHarness.decisions', snapshot.decisions],
      ['deepseekHarness.sandboxMode', snapshot.sandboxMode],
      ['deepseekHarness.otelTracing', persistedOtelTracingSettings(snapshot.tracing)],
      ['deepseekHarness.mcpServers', snapshot.mcpServers],
    ] as const) {
      try {
        if (key === 'deepseekHarness.otelTracing') this.applyingTracingConfig = true
        await configuration.update(key, value, vscode.ConfigurationTarget.Global)
      } catch (error) {
        errors.push(error)
      } finally {
        if (key === 'deepseekHarness.otelTracing') this.applyingTracingConfig = false
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

function validateGrpcTarget(value: string, index: number): void {
  if (value.startsWith('unix://')) {
    try {
      const parsed = new URL(value)
      if (!parsed.pathname) throw new Error()
    } catch {
      throw new Error(`OTLP destination ${index + 1} needs a valid gRPC target.`)
    }
    return
  }

  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    throw new Error(`OTLP destination ${index + 1} needs a valid gRPC target.`)
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host) {
    throw new Error(`OTLP destination ${index + 1} needs a valid gRPC target.`)
  }
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

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'FileNotFound'
}
