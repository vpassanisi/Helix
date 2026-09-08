import type {
  ContentBlock,
  HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client'
import type { PersistedMcpServer, RuntimeMcpServer } from './mcp.js'

export type { ContentBlock, HarnessNotification }
export type { PersistedMcpServer, RuntimeMcpServer } from './mcp.js'

export interface RuntimeOptions {
  cwd: string
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
  contextWindow?: number
  dshBin?: string
  dshHome?: string
  mcpServers: RuntimeMcpServer[]
}

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'error'

export interface RoutedNotification {
  rootSessionId: string
  sessionId: string
  notification: HarnessNotification
}

export type SessionRouteMode = 'exact' | 'tree'

export interface DisposableLike {
  dispose(): void
}
