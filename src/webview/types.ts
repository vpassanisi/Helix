export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'error'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface SelectionMetadata {
  fileLabel: string
  languageId: string
  ranges: Array<{
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  }>
}

export interface SidebarSettings {
  provider: string
  model: string
  contextWindow: number
  baseUrl: string
  dshHome: string
  apiKeyConfigured: boolean
  sandboxMode: SandboxMode
  mcpServers: SidebarMcpServerSetting[]
}

export type SidebarMcpTransport = 'stdio' | 'streamable-http'

export interface SidebarMcpEnvironment {
  name: string
  value?: string
  configured?: boolean
}

export interface SidebarMcpServer {
  serverName: string
  transport: SidebarMcpTransport
  command: string
  args: string[]
  url: string
  env: SidebarMcpEnvironment[]
}

export interface SidebarMcpServerSetting extends Omit<SidebarMcpServer, 'env'> {
  env: Array<{ name: string; configured: boolean }>
}

export interface SidebarModel {
  id: string
  displayName?: string
  contextWindow?: number
  loaded?: boolean
}

export type CodeChangeKind = 'created' | 'modified' | 'deleted' | 'renamed'

export interface CodeChange {
  path: string
  kind: CodeChangeKind
  additions: number
  deletions: number
  oldPath?: string
}

export type SidebarMessage =
  | { type: 'ready' }
  | { type: 'openSettings' }
  | {
      type: 'saveSettings'
      provider: string
      baseUrl: string
      apiKey?: string
      clearApiKey: boolean
      sandboxMode: SandboxMode
      mcpServers: SidebarMcpServer[]
    }
  | { type: 'submit'; prompt: string; includeSelection: boolean }
  | { type: 'newSession' }
  | { type: 'refreshModels' }
  | { type: 'selectModel'; model: string; contextWindow?: number }
  | { type: 'setSandboxMode'; sandboxMode: SandboxMode }
  | { type: 'cancelTurn' }
  | { type: 'approvalDecision'; sessionId: string; requestId: string; outcome: 'allowed-once' | 'rejected' }

export interface WebviewApi {
  postMessage(message: SidebarMessage): void
}

export type IncomingMessage =
  | { type: 'state'; state: { activeSessionId: string; runtimeState: RuntimeState; selection?: SelectionMetadata }; resetTranscript?: boolean }
  | { type: 'settings'; settings: SidebarSettings }
  | { type: 'settingsSaved'; settings: SidebarSettings; restarting: boolean }
  | { type: 'selection'; selection?: SelectionMetadata }
  | { type: 'codeChanges'; sessionId: string; changes: CodeChange[]; active: boolean }
  | { type: 'notification'; sessionId: string; notification: unknown }
  | { type: 'error'; message: string }
  | { type: 'accepted'; sessionId: string }
  | { type: 'models'; models: SidebarModel[]; error?: string }
  | {
      type: 'approvalRequest'
      sessionId: string
      agentSessionId: string
      requestId: string
      toolCallId?: string
      toolName: string
      reason?: string
    }
  | {
      type: 'approvalResolved'
      sessionId: string
      requestId: string
      outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    }

export interface HarnessNotification {
  method?: string
  params?: Record<string, unknown>
}

export interface HarnessEvent {
  type?: string
  data?: Record<string, unknown>
}
