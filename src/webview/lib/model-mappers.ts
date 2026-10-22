import { isRecord } from '../../shared/value-utils.js'
import { formatTokenCount } from '../formatting.js'
import type { ChatTemplateValue } from '../../runtime/model-catalog.js'
import type {
  McpServerDraft,
  ModelDraft,
  ModelEditorDraft,
  SidebarDiscoveredModel,
  SidebarMcpServer,
  SidebarMcpServerSetting,
  SidebarModel,
} from '../types.js'

export function toModelEditorDraft(entry: SidebarModel, key: number): ModelEditorDraft {
  const { reasoningEfforts, chatTemplateKwargs, chatTemplateArgs, ...modelEntry } = entry
  return {
    ...modelEntry,
    key,
    sourceId: entry.id,
    acceptsImages: entry.acceptsImages ?? false,
    reasoningFormat: entry.reasoningFormat ?? 'auto',
    binaryThinkingMode: entry.binaryThinkingMode ?? 'on',
    reasoningEfforts: reasoningEfforts ?? [],
    chatTemplateKwargsText: JSON.stringify(chatTemplateKwargs ?? {}, null, 2),
    chatTemplateArgsText: JSON.stringify(chatTemplateArgs ?? {}, null, 2),
  }
}

export function discoveredToEditorDraft(entry: SidebarDiscoveredModel, key: number): ModelEditorDraft {
  const { loaded: _loaded, reasoningEfforts, ...modelEntry } = entry
  return {
    ...modelEntry,
    key,
    acceptsImages: false,
    reasoningEfforts: reasoningEfforts ?? [],
    reasoningFormat: 'auto',
    binaryThinkingMode: 'on',
    chatTemplateKwargsText: '{}',
    chatTemplateArgsText: '{}',
  }
}

export function parseChatTemplateDraft(value: string, label: string): Record<string, ChatTemplateValue> | undefined {
  if (!value.trim()) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} must be valid JSON. ${reason}`)
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object.`)
  return parsed as Record<string, ChatTemplateValue>
}

export function toModelDraft(draft: ModelEditorDraft): ModelDraft {
  return {
    id: draft.id,
    displayName: draft.displayName,
    contextWindow: draft.contextWindow,
    acceptsImages: draft.acceptsImages ?? false,
    sourceId: draft.sourceId,
    reasoningEfforts: [...draft.reasoningEfforts],
    reasoningFormat: draft.reasoningFormat,
    binaryThinkingMode: draft.binaryThinkingMode,
    chatTemplateKwargs: parseChatTemplateDraft(draft.chatTemplateKwargsText, `Model "${draft.id}" chat template kwargs`),
    chatTemplateArgs: parseChatTemplateDraft(draft.chatTemplateArgsText, `Model "${draft.id}" chat template args`),
  }
}

export function modelOptionLabel(option: SidebarModel): string {
  const name = option.displayName ?? option.id
  const context = option.contextWindow === undefined ? '' : ` · ${formatTokenCount(option.contextWindow)}`
  return `${name}${context}`
}

export function toMcpServerDraft(server: SidebarMcpServerSetting): McpServerDraft {
  return {
    serverName: server.serverName,
    transport: server.transport,
    command: server.command,
    argsText: server.args.join('\n'),
    url: server.url,
    env: server.env.map((entry) => ({ name: entry.name, value: '', configured: entry.configured })),
  }
}

export function toMcpServerMessage(server: McpServerDraft): SidebarMcpServer {
  return {
    serverName: server.serverName,
    transport: server.transport,
    command: server.command,
    args: server.argsText.split(/\r?\n/).map((argument) => argument.trim()).filter(Boolean),
    url: server.url,
    env: server.env.map(({ name, value, configured }) => ({ name, value, configured })),
  }
}
