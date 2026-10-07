import { isDecisionSettings, isSkillDraft, isSkillOverrides, type DecisionSettings, type SkillCatalog, type SkillDraft, type SkillOverrides, type SkillSuggestions } from '../shared/skills.js'
import type { RequestPreviewResult } from '../runtime/control-protocol.js'
import type { BinaryThinkingMode, ChatTemplateValue, ReasoningFormat } from '../runtime/model-catalog.js'
import type { BrowserContextState } from '../shared/browser-context.js'
import type { PendingUserQuestion, UserQuestionAnswer } from '../shared/user-question.js'
export type { RequestPreviewResult } from '../runtime/control-protocol.js'

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'error'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type SettingsPage = 'connection' | 'models' | 'mcp' | 'preview'

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
  skillPickerEnabled?: boolean
  decisions?: DecisionSettings & { apiKeyConfigured: boolean }
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
  acceptsImages?: boolean
  reasoningEfforts?: string[]
  reasoningFormat?: ReasoningFormat
  binaryThinkingMode?: BinaryThinkingMode
  chatTemplateKwargs?: Record<string, ChatTemplateValue>
  chatTemplateArgs?: Record<string, ChatTemplateValue>
}

export interface SidebarDiscoveredModel extends SidebarModel {
  loaded?: boolean
}

export interface ModelDraft extends SidebarModel {
  sourceId?: string
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
  | { type: 'loadSkills'; sessionId: string }
  | { type: 'analyzeSkills'; draft: SkillDraft }
  | { type: 'ready' }
  | { type: 'openSettings' }
  | {
      type: 'saveSettings'
      provider: string
      baseUrl: string
      apiKey?: string
      clearApiKey: boolean
      decisions?: DecisionSettings
      decisionsApiKey?: string
      clearDecisionsApiKey?: boolean
      sandboxMode: SandboxMode
    }
  | { type: 'saveMcpServers'; mcpServers: SidebarMcpServer[] }
  | { type: 'submit'; prompt: string; includeSelection: boolean; reasoningEffort?: string | null; sessionId?: string; browserAttachmentIds?: string[]; skillDraft?: SkillDraft; skillOverrides?: SkillOverrides }
  | { type: 'toggleBrowserPicker' }
  | { type: 'removeBrowserAttachment'; sessionId: string; id: string }
  | { type: 'newSession' }
  | { type: 'refreshModels' }
  | { type: 'loadModelCatalog' }
  | { type: 'saveModelCatalog'; models: ModelDraft[] }
  | { type: 'selectModel'; model: string }
  | { type: 'setSandboxMode'; sandboxMode: SandboxMode }
  | { type: 'cancelTurn' }
  | { type: 'previewRequest'; prompt: string }
  | { type: 'cancelRequestPreview' }
  | { type: 'approvalDecision'; sessionId: string; requestId: string; outcome: 'allowed-once' | 'rejected' }
  | { type: 'questionAnswer'; sessionId: string; requestId: string; answer: UserQuestionAnswer }

export interface WebviewApi {
  postMessage(message: SidebarMessage): void
}

export type IncomingMessage =
  | { type: 'skillsInvalidated' }
  | { type: 'skillCatalog'; sessionId: string; catalog: SkillCatalog; error?: string }
  | { type: 'skillSuggestions'; suggestions: SkillSuggestions }
  | { type: 'submitFailed'; sessionId: string; message: string }
  | { type: 'questionRequest'; request: PendingUserQuestion }
  | { type: 'questionResolved'; sessionId: string; requestId: string; status: 'answered' | 'cancelled' | 'unavailable'; answer?: UserQuestionAnswer }
  | { type: 'questionAnswerFailed'; sessionId: string; requestId: string; message: string }
  | { type: 'browserContext'; state: BrowserContextState }
  | { type: 'browserSubmitFailed'; sessionId: string; message: string }
  | { type: 'state'; state: { activeSessionId: string; runtimeState: RuntimeState; reasoningEffort?: string; selection?: SelectionMetadata; browserContext?: BrowserContextState; pendingQuestions?: PendingUserQuestion[] }; resetTranscript?: boolean }
  | { type: 'settings'; settings: SidebarSettings }
  | { type: 'settingsSaved'; settings: SidebarSettings; restarting: boolean }
  | { type: 'selection'; selection?: SelectionMetadata }
  | { type: 'codeChanges'; sessionId: string; changes: CodeChange[]; active: boolean }
  | { type: 'notification'; sessionId: string; notification: unknown }
  | { type: 'assistantStream'; sessionId: string; agentSessionId: string; frame: unknown }
  | { type: 'error'; message: string }
  | { type: 'accepted'; sessionId: string; modelId: string; reasoningEffort?: string }
  | { type: 'discoveredModels'; models: SidebarDiscoveredModel[]; error?: string }
  | { type: 'modelCatalog'; models: SidebarModel[]; reasoningHistory: Record<string, string>; error?: string }
  | { type: 'modelCatalogSaved'; models: SidebarModel[]; reasoningHistory: Record<string, string>; runtimeRestarting: boolean }
  | { type: 'requestPreviewState'; state: 'loading' | 'success' | 'error' | 'cancelled'; preview?: RequestPreviewResult; message?: string }
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
