import type {
  ContentBlock,
  HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client'
import type { PersistedMcpServer, RuntimeMcpServer } from './mcp.js'
import type { SavedModel } from './model-catalog.js'

export type { ContentBlock, HarnessNotification }
export type { PersistedMcpServer, RuntimeMcpServer } from './mcp.js'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface RuntimePluginBundle {
  id: string
  modulePath: string
  config: Record<string, unknown>
}

export interface RuntimeOptions {
  cwd: string
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
  contextWindow?: number
  savedModels?: SavedModel[]
  dshBin?: string
  dshHome?: string
  /** Model tool bundles to leave out; applied when the runtime starts. */
  disabledToolBundles?: string[]
  /** Optional isolated session store used by short-lived tooling runtimes. */
  sessionStorageRoot?: string
  plugins?: RuntimePluginBundle[]
  sandboxMode: SandboxMode
  mcpServers: RuntimeMcpServer[]
}

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'error'

export interface RoutedNotification {
  rootSessionId: string
  sessionId: string
  notification: HarnessNotification
}

export interface DisposableLike {
  dispose(): void
}
