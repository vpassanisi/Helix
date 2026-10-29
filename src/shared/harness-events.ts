import { isRecord, responseKey, stringValue } from './value-utils.js'

export interface AssistantTextBlock {
  role: 'assistant' | 'reasoning'
  text: string
}

export interface ToolCallLink {
  data: Record<string, unknown>
  message: Record<string, unknown>
  sessionId: string | undefined
  callsByStep: Record<string, string>
  activeSessionId: string
}

export function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

export function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(toolResultText).filter(Boolean).join('\n\n')
  if (!isRecord(value)) return ''
  if (typeof value.text === 'string') return value.text
  if (Array.isArray(value.content)) return toolResultText(value.content)
  if ('value' in value) return stringifyPayload(value.value)
  return ''
}

export function toolResultIsError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(toolResultIsError)
  if (!isRecord(value)) return false
  return value.isError === true || (Array.isArray(value.content) && toolResultIsError(value.content))
}

export function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function contextUsageTotal(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const parts = [value.inputTokens, value.outputTokens, value.cacheReadTokens, value.cacheWriteTokens].map(numericValue)
  if (parts.every((part) => part === undefined)) return undefined
  return parts.reduce<number>((total, part) => total + (part ?? 0), 0)
}

export function assistantTextBlocks(content: unknown): AssistantTextBlock[] {
  if (!Array.isArray(content)) return []
  const blocks: AssistantTextBlock[] = []
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string' || typeof block.text !== 'string') continue
    if (block.type === 'text') blocks.push({ role: 'assistant', text: block.text })
    if (block.type === 'reasoning') blocks.push({ role: 'reasoning', text: block.text })
  }
  return blocks
}

export function toolStepKey(sessionId: string | undefined, data: Record<string, unknown>, activeSessionId: string): string | undefined {
  const response = responseKey(data)
  if (!response) return undefined
  return `${sessionId ?? activeSessionId}:${response}`
}

export function toolCallId(data: Record<string, unknown>, fallback: string): string {
  return stringValue(data.callId) ?? responseKey(data) ?? fallback
}

export function toolResultCallId(link: ToolCallLink, fallback: string): string {
  return directCallId(link.data, link.message)
    ?? stepCallId(link)
    ?? responseKey(link.data)
    ?? fallback
}

function stepCallId(link: ToolCallLink): string | undefined {
  const key = toolStepKey(link.sessionId, link.data, link.activeSessionId)
  return key === undefined ? undefined : link.callsByStep[key]
}

function directCallId(data: Record<string, unknown>, message: Record<string, unknown>): string | undefined {
  const callId = stringValue(data.callId)
  if (callId !== undefined) return callId

  const source = isRecord(message.source) ? message.source : undefined
  const sourceCallId = source === undefined ? undefined : stringValue(source.callId)
  if (sourceCallId !== undefined) return sourceCallId

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue
      const blockCallId = stringValue(block.toolCallId)
      if (blockCallId !== undefined) return blockCallId
    }
  }

  return undefined
}
