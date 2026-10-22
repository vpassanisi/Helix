import { DEFAULT_DECISION_SETTINGS, type DecisionSettings } from '../../shared/skills.js'
import { DEFAULT_OTEL_TRACING_SETTINGS, type OtelTracingSettings } from '../../shared/otel-tracing.js'
import { toMcpServerDraft, toMcpServerMessage } from './model-mappers.js'
import type { McpServerDraft, SandboxMode, SettingsPage, SidebarMessage, SidebarSettings } from '../types.js'

export type StatusTone = 'success' | 'warning' | ''

const PAGE_TITLES: Record<SettingsPage, string> = {
  connection: 'Connection Settings',
  models: 'Models',
  tools: 'Tools',
  mcp: 'MCP Servers',
  preview: 'Request Previewer',
  about: 'About Helix',
}

/**
 * The settings page: which page is open, the one-line status the pages report
 * into, restart flags, and the editable drafts for connection and MCP servers.
 */
export class SettingsPageState {
  page = $state<SettingsPage | undefined>()
  status = $state('')
  tone = $state<StatusTone>('')
  restarting = $state(false)
  mcpSaving = $state(false)

  provider = $state('')
  baseUrl = $state('')
  apiKey = $state('')
  clearApiKey = $state(false)
  sandboxMode = $state<SandboxMode>('workspace-write')
  tracing = $state<OtelTracingSettings>({ ...DEFAULT_OTEL_TRACING_SETTINGS })
  decisions = $state<DecisionSettings>({ ...DEFAULT_DECISION_SETTINGS })
  decisionsApiKey = $state('')
  clearDecisionsApiKey = $state(false)
  mcpServers = $state<McpServerDraft[]>([])

  setStatus(text: string, tone: StatusTone): void {
    this.status = text
    this.tone = tone
  }

  title(page: SettingsPage): string {
    return PAGE_TITLES[page]
  }

  open(page: SettingsPage): void {
    this.page = page
    this.setStatus('', '')
  }

  close(): void {
    this.page = undefined
    this.setStatus('', '')
  }

  loadConnection(next: SidebarSettings): void {
    this.provider = next.provider
    this.baseUrl = next.baseUrl
    this.sandboxMode = next.sandboxMode
    this.tracing = { ...DEFAULT_OTEL_TRACING_SETTINGS, ...next.tracing }
    this.apiKey = ''
    this.clearApiKey = false
    this.decisions = { ...DEFAULT_DECISION_SETTINGS, ...next.decisions }
    this.decisionsApiKey = ''
    this.clearDecisionsApiKey = false
  }

  loadMcp(next: SidebarSettings): void {
    this.mcpServers = next.mcpServers.map(toMcpServerDraft)
  }

  /** Drops the key drafts so a fresh page shows the saved state, not a half-typed edit. */
  resetDrafts(page: SettingsPage, saved: SidebarSettings | undefined): void {
    if (saved === undefined) return
    if (page === 'connection') this.loadConnection(saved)
    if (page === 'mcp') this.loadMcp(saved)
  }

  beginSave(): void {
    this.restarting = true
    this.setStatus('Applying settings…', 'warning')
  }

  beginMcpSave(): void {
    this.mcpSaving = true
    this.restarting = true
    this.setStatus('Applying MCP server settings…', 'warning')
  }

  saveRejected(reason: string): void {
    this.restarting = false
    this.setStatus(`Could not send connection settings: ${reason}`, 'warning')
  }

  buildSaveMessage(skillPickerEnabled: boolean): Extract<SidebarMessage, { type: 'saveSettings' }> {
    return {
      type: 'saveSettings',
      provider: this.provider,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      clearApiKey: this.clearApiKey,
      ...(skillPickerEnabled
        ? { decisions: { ...this.decisions }, decisionsApiKey: this.decisionsApiKey, clearDecisionsApiKey: this.clearDecisionsApiKey }
        : {}),
      sandboxMode: this.sandboxMode,
      tracing: this.tracing,
    }
  }

  buildMcpMessage(): Extract<SidebarMessage, { type: 'saveMcpServers' }> {
    return { type: 'saveMcpServers', mcpServers: this.mcpServers.map(toMcpServerMessage) }
  }
}
