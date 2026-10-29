import { DEFAULT_DECISION_SETTINGS, decisionEndpoint, type DecisionSettings } from '../shared/skills.js'
import type { DecisionConnection } from './decision-client.js'
import * as vscode from 'vscode'
import { ControlBridgeError } from '../runtime/control-bridge.js'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { mcpSecretKey } from '../runtime/mcp.js'
import { configuredPluginBundles, createOtelTracingPlugin } from '../runtime/plugins.js'
import {
  activeSelectionAfterCatalogSave,
  modelEndpointCandidates,
  normalizeModelDrafts,
  parseModelCatalog,
  reconcileReasoningEffortHistory,
  selectionForSavedModel,
  validateModelDraftSources,
  type DiscoveredModel,
  type SavedModel,
} from '../runtime/model-catalog.js'
import { HarnessRuntime } from '../runtime/harness-runtime.js'
import { SerialTaskQueue } from '../runtime/serial-task-queue.js'
import type { PersistedMcpServer, RuntimeOptions, RuntimeState, SandboxMode } from '../runtime/types.js'
import { normalizeDisabledToolBundles } from '../shared/tool-bundles.js'
import {
  normalizeOtelTracingSettings,
  persistedOtelTracingSettings,
  type OtelTracingSettings,
} from '../shared/otel-tracing.js'
import {
  SidebarProvider,
  type SidebarMessage,
  type SidebarSettings,
} from '../sidebar/sidebar-provider.js'
import {
  buildRuntimeTracingConfig,
  buildSidebarTracingSettings,
  otelEndpointSecretKey,
  syncTracingSecrets,
  validateTracingEndpoints,
  validateTracingSecrets,
} from './tracing-settings.js'
import {
  configuredMcpServers,
  normalizeMcpServers,
  runtimeMcpServers,
  sidebarMcpServers,
  syncMcpSecrets,
  validateMcpSecretReferences,
} from './mcp-settings.js'
import {
  readModelCatalogFile,
  reasoningEffortHistory,
  rememberModelReasoningEffort,
  REASONING_HISTORY_KEY,
  resolveModelReasoningEffort,
  writeModelCatalogFile,
} from './model-catalog-store.js'

const API_KEY_SECRET = 'deepseekHarness.apiKey'
const DECISIONS_KEY_SECRET = 'deepseekHarness.decisionsApiKey'

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
  /** The bundle list the running runtime was started with, if it was started. */
  private appliedDisabledToolBundles: string[] | undefined

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
    const builtInModels = provider === 'deepseek-official'
      ? resolveAdapterOptions({}).models.map((model) => ({
        id: model.id,
        ...(model.name !== model.id ? { displayName: model.name } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      }))
      : []

    if (endpoints.length === 0) {
      this.postDiscoveredModels(builtInModels, 'Set an API base URL to discover available models.')
      return
    }

    const apiKey = await this.options.context.secrets.get(API_KEY_SECRET)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    let lastError = 'The models endpoint did not respond.'

    for (const endpoint of endpoints) {
      try {
        const models = await fetchModelEndpoint(endpoint, headers)
        this.postDiscoveredModels(mergeDiscoveredModels(builtInModels, models))
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    this.postDiscoveredModels(builtInModels, `Could not fetch models. ${lastError}`)
  }

  async loadModelCatalog(): Promise<void> {
    try {
      this.postModelCatalog(await this.readModelCatalog())
    } catch (error) {
      this.postModelCatalog([], `Could not read the models file. ${formatError(error)}`)
    }
  }

  reasoningEffortHistory(): Record<string, string> {
    return reasoningEffortHistory(this.options.context)
  }

  async resolveReasoningEffort(selection: string | null, modelId = vscode.workspace.getConfiguration('deepseekHarness').get<string>('model', 'deepseek-flash')): Promise<string | undefined> {
    return resolveModelReasoningEffort(this.options.context, selection, modelId)
  }

  /**
   * The instructions this model's card carries, for the session that selected it.
   * A models file that cannot be read sends the message without them.
   */
  async modelInstructions(modelId: string): Promise<string | undefined> {
    try {
      return (await this.readModelCatalog()).find((entry) => entry.id === modelId)?.systemInstructions
    } catch {
      return undefined
    }
  }

  async rememberReasoningEffort(modelId: string, effort: string | undefined): Promise<void> {
    await rememberModelReasoningEffort(this.options.context, modelId, effort)
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
          model: configuration.get<string>('model', 'deepseek-flash'),
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
      if (nextTracing !== undefined) await validateTracingSecrets(nextTracing, this.options.context.secrets)
      const previousServers = configuredMcpServers()
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
      const previousServers = configuredMcpServers()
      const nextServers = normalizeMcpServers(message.mcpServers)
      await validateMcpSecretReferences(this.options.context.secrets, message.mcpServers)
      const snapshot = await this.createSnapshot(previousServers, nextServers)

      try {
        await syncMcpSecrets(this.options.context.secrets, nextServers, message.mcpServers)
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
    const disabledToolBundles = this.disabledToolBundles()
    this.appliedDisabledToolBundles = disabledToolBundles
    return {
      cwd: workspaceFolder?.uri.fsPath ?? vscode.env.appRoot,
      provider: configuration.get<string>('provider', 'deepseek-official'),
      model: configuration.get<string>('model', 'deepseek-flash'),
      apiKey: await this.options.context.secrets.get(API_KEY_SECRET),
      baseUrl: configuration.get<string>('baseUrl', '') || undefined,
      contextWindow: contextWindow > 0 ? contextWindow : undefined,
      savedModels: await this.readModelCatalog(),
      dshBin: configuration.get<string>('dshBin', '') || undefined,
      dshHome: configuration.get<string>('dshHome', '') || undefined,
      plugins: [
        createOtelTracingPlugin(extensionPath, await buildRuntimeTracingConfig(this.options.context.secrets)),
        ...configuredPluginBundles(configuration.get<unknown>('plugins', []), extensionPath),
      ],
      sandboxMode: normalizeSandboxMode(configuration.get<string>('sandboxMode', 'workspace-write')),
      mcpServers: await runtimeMcpServers(this.options.context.secrets),
      disabledToolBundles,
    }
  }

  /** The saved list, with unknown and locked ids dropped. */
  disabledToolBundles(): string[] {
    return normalizeDisabledToolBundles(vscode.workspace.getConfiguration('deepseekHarness').get<unknown>('disabledToolBundles', []))
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
      model: configuration.get<string>('model', 'deepseek-flash'),
      contextWindow: configuration.get<number>('contextWindow', 0),
      baseUrl: configuration.get<string>('baseUrl', ''),
      dshHome: configuration.get<string>('dshHome', ''),
      apiKeyConfigured: Boolean(await this.options.context.secrets.get(API_KEY_SECRET)),
      skillPickerEnabled: this.skillPickerEnabled(),
      decisions: { ...this.readDecisionSettings(), apiKeyConfigured: Boolean(await this.options.context.secrets.get(DECISIONS_KEY_SECRET)) },
      sandboxMode: normalizeSandboxMode(configuration.get<string>('sandboxMode', 'workspace-write')),
      tracing: await buildSidebarTracingSettings(this.options.context.secrets),
      mcpServers: await sidebarMcpServers(this.options.context.secrets),
      disabledToolBundles: this.disabledToolBundles(),
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
    validateTracingEndpoints(tracing)
  }

  private async writeSettings(message: Extract<SidebarMessage, { type: 'saveSettings' }>, tracing?: OtelTracingSettings): Promise<void> {
    const configuration = vscode.workspace.getConfiguration()
    await configuration.update('deepseekHarness.provider', message.provider.trim(), vscode.ConfigurationTarget.Global)
    await configuration.update('deepseekHarness.baseUrl', message.baseUrl.trim(), vscode.ConfigurationTarget.Global)
    await configuration.update('deepseekHarness.sandboxMode', message.sandboxMode, vscode.ConfigurationTarget.Global)
    if (tracing !== undefined) {
      this.applyingTracingConfig = true
      try {
        await syncTracingSecrets(tracing, this.options.context.secrets)
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

  /**
   * Tool bundles are launch scoped, so saving does not restart the runtime.
   * The running session keeps its tools; applyDeferredToolBundles picks the
   * change up when the Webview starts a new session.
   */
  async saveTools(message: Extract<SidebarMessage, { type: 'saveTools' }>): Promise<void> {
    try {
      const next = normalizeDisabledToolBundles(message.disabledToolBundles)
      await vscode.workspace.getConfiguration().update('deepseekHarness.disabledToolBundles', next, vscode.ConfigurationTarget.Global)
      const settings = await this.getSidebarSettings()
      this.options.sidebar.post({ type: 'settingsSaved', settings, restarting: false })
    } catch (error) {
      this.options.onError(error)
    }
  }

  /** Restarts the runtime when the saved bundle list differs from the running one. */
  async applyDeferredToolBundles(): Promise<boolean> {
    const saved = this.disabledToolBundles()
    if (this.appliedDisabledToolBundles === undefined) return false
    if (this.appliedDisabledToolBundles.join('|') === saved.join('|')) return false
    if (this.options.getRuntimeState() === 'stopped') {
      this.appliedDisabledToolBundles = saved
      return false
    }
    try {
      await this.options.runtime.restart(await this.runtimeOptions())
      return true
    } catch (error) {
      this.options.onError(error)
      return false
    }
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
    const read = readModelCatalogFile(this.options.context)
    this.catalogReadInFlight = read
    try {
      return await read
    } finally {
      if (this.catalogReadInFlight === read) this.catalogReadInFlight = undefined
    }
  }

  private async writeModelCatalog(models: SavedModel[]): Promise<void> {
    await writeModelCatalogFile(this.options.context, models)
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

function mergeDiscoveredModels(defaultModels: DiscoveredModel[], fetchedModels: DiscoveredModel[]): DiscoveredModel[] {
  const models = new Map(defaultModels.map((model) => [model.id, model]))
  for (const model of fetchedModels) models.set(model.id, { ...models.get(model.id), ...model })
  return [...models.values()]
}

function normalizeSandboxMode(value: unknown): SandboxMode {
  return value === 'read-only' || value === 'danger-full-access' ? value : 'workspace-write'
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
