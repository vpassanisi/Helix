import { isRecord, stringValue } from './value-utils.js'
import type { PreviewPromptSection, RequestPreviewResult } from '../runtime/control-protocol.js'

export interface RequestPreviewPromptItem {
  role: string
  source?: string
  text?: string
  sections?: PreviewPromptSection[]
}

export interface RequestPreviewDetail {
  label: string
  value: string
}

export interface RequestPreviewTool {
  name: string
  description: string
  parameters: unknown
}

export interface RequestPreviewView {
  provider: string
  model: string
  promptItems: RequestPreviewPromptItem[]
  details: RequestPreviewDetail[]
  tools: RequestPreviewTool[]
}

export function createRequestPreviewView(preview: RequestPreviewResult): RequestPreviewView {
  const { request, promptBreakdown } = preview
  const systemSections = promptBreakdown?.systemSections ?? []
  const contextSections = promptBreakdown?.contextSections ?? []
  const systemText = systemSections.map((section) => section.text).join('\n\n')
  const promptItems: RequestPreviewPromptItem[] = []
  let systemSectionsUsed = false

  if (typeof request.system === 'string') {
    const useSections = systemSections.length > 0 && request.system === systemText
    promptItems.push({
      role: 'system',
      ...(useSections ? { sections: systemSections } : { text: request.system }),
    })
    systemSectionsUsed ||= useSections
  }

  for (const [index, message] of request.messages.entries()) {
    if (!isRecord(message)) {
      promptItems.push({ role: `Message ${index + 1}`, text: formatPreviewContent(message) })
      continue
    }

    const role = stringValue(message.role) ?? `Message ${index + 1}`
    const source = isRecord(message.source) ? message.source : undefined
    const sourceLabel = formatSource(source)
    const text = formatPreviewContent(message.content)

    if (role === 'system' && !systemSectionsUsed && systemSections.length > 0 && text === systemText) {
      promptItems.push({ role, ...(sourceLabel ? { source: sourceLabel } : {}), sections: systemSections })
      systemSectionsUsed = true
      continue
    }

    if (source?.form === 'snapshot' && contextSections.length > 0) {
      promptItems.push({ role, ...(sourceLabel ? { source: sourceLabel } : {}), sections: contextSections })
      continue
    }

    promptItems.push({ role, ...(sourceLabel ? { source: sourceLabel } : {}), text })
  }

  const details: RequestPreviewDetail[] = [
    { label: 'Reasoning effort', value: request.reasoningEffort ?? 'Model default' },
  ]
  if (request.temperature !== undefined) details.push({ label: 'Temperature', value: String(request.temperature) })
  if (request.maxTokens !== undefined) details.push({ label: 'Max tokens', value: String(request.maxTokens) })
  if (request.stop !== undefined) details.push({ label: 'Stop sequences', value: request.stop.join(', ') || 'None' })

  return {
    provider: request.provider,
    model: request.model,
    promptItems,
    details,
    tools: (request.tools ?? []).map((tool, index) => {
      const record = isRecord(tool) ? tool : undefined
      return {
        name: stringValue(record?.name) ?? `Tool ${index + 1}`,
        description: stringValue(record?.description) ?? '',
        parameters: record?.parameters ?? {},
      }
    }),
  }
}

function formatSource(source: Record<string, unknown> | undefined): string | undefined {
  if (source === undefined) return undefined
  if (source.kind === 'plugin') return stringValue(source.plugin) ?? 'DSH plugin'
  if (source.kind === 'tool') return 'Tool result'
  if (source.kind === 'model') {
    const provider = stringValue(source.provider)
    const model = stringValue(source.model)
    return [provider, model].filter(Boolean).join(' / ') || 'Model response'
  }
  if (source.kind === 'user') return 'User input'
  return stringValue(source.kind)
}

function formatPreviewContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return safeStringify(value)
  return value.map((block) => {
    if (!isRecord(block)) return safeStringify(block)
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    const kind = stringValue(block.type) ?? 'content'
    return `[${kind} block]\n${safeStringify(block)}`
  }).join('\n\n')
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2)
    return serialized ?? String(value)
  } catch {
    return String(value)
  }
}
