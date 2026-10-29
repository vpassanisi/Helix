import { renderContextSections, renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import {
  type PreviewPromptBreakdown,
  type PreviewRequest,
} from './control-protocol.js'
import { isRecord, stringValue } from '../shared/value-utils.js'
import { PluginControlError } from './dsh-control-shared.js'

/**
 * Request previews and provider-request capture: an armed session's next
 * model request is reported (and the turn is replaced by an immediate stop)
 * so the Host can show exactly what would have been sent.
 */
export class DshPreviewCapture {
  private readonly requestPreviews = new Map<string, string>()
  private readonly requestPreviewBreakdowns = new Map<string, PreviewPromptBreakdown>()
  providerRequestCaptureSessionId: string | undefined

  constructor(
    private readonly emit: (sessionId: string, method: 'request.previewCaptured' | 'provider.requestCaptured', params: Record<string, unknown>) => boolean,
  ) {}

  arm(sessionId: string, params: Record<string, unknown>): void {
    const captureId = stringValue(params.captureId)
    if (captureId === undefined) throw new PluginControlError('Preview capture ID is required.', 'INVALID_ARGUMENT')
    this.requestPreviews.set(sessionId, captureId)
    this.requestPreviewBreakdowns.delete(sessionId)
  }

  captureNextProviderRequest(sessionId: string): void {
    this.providerRequestCaptureSessionId = sessionId
  }

  /** The wrapped fetch reported the armed session's next chat-completions call. */
  handleProviderCapture(sessionId: string, url: string, body: string | null): void {
    this.providerRequestCaptureSessionId = undefined
    this.emit(sessionId, 'provider.requestCaptured', { url, body })
  }

  /**
   * The assembled prompt of the armed turn, captured when the system prompt
   * is assembled, so the preview shows the full text that would have been sent.
   */
  recordPromptBreakdown(assembled: unknown, sessionId: string): void {
    if (this.requestPreviews.has(sessionId) && !this.requestPreviewBreakdowns.has(sessionId)) {
      const breakdown = canonicalPromptBreakdown(assembled)
      if (breakdown !== undefined) this.requestPreviewBreakdowns.set(sessionId, breakdown)
    }
  }

  onLlmStream = (options: any, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> => {
    const sessionId = stringValue(options?.sessionId)
    if (sessionId === undefined || options?.purpose !== undefined) return next()
    const captureId = this.requestPreviews.get(sessionId)
    if (captureId === undefined) return next()

    this.requestPreviews.delete(sessionId)
    const promptBreakdown = this.requestPreviewBreakdowns.get(sessionId)
    this.requestPreviewBreakdowns.delete(sessionId)
    this.emit(sessionId, 'request.previewCaptured', {
      captureId,
      request: canonicalPreviewRequest(options),
      ...(promptBreakdown === undefined ? {} : { promptBreakdown }),
    })
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }

  clear(): void {
    this.requestPreviews.clear()
    this.requestPreviewBreakdowns.clear()
    this.providerRequestCaptureSessionId = undefined
  }
}

function canonicalPreviewRequest(options: any): PreviewRequest {
  const request: PreviewRequest = {
    provider: typeof options?.provider === 'string' ? options.provider : '',
    model: typeof options?.model === 'string' ? options.model : '',
    messages: Array.isArray(options?.messages) ? options.messages : [],
  }
  if (typeof options?.reasoningEffort === 'string') request.reasoningEffort = options.reasoningEffort
  if (typeof options?.system === 'string') request.system = options.system
  if (Array.isArray(options?.tools)) request.tools = options.tools
  if (typeof options?.temperature === 'number') request.temperature = options.temperature
  if (typeof options?.maxTokens === 'number') request.maxTokens = options.maxTokens
  if (Array.isArray(options?.stop)) request.stop = options.stop
  return request
}

function canonicalPromptBreakdown(value: unknown): PreviewPromptBreakdown | undefined {
  if (!isRecord(value) || !Array.isArray(value.sections) || !Array.isArray(value.contexts) || !isRecord(value.variables)) {
    return undefined
  }

  try {
    const assembly = value as unknown as PromptAssembly
    const systemSections = assembly.sections.flatMap((section) => {
      if (typeof section.name !== 'string') return []
      const text = renderPrompt({ ...assembly, sections: [section] })
      return text.length === 0 ? [] : [{ name: section.name, text }]
    })
    const contextSections = renderContextSections(assembly).map(({ name, text }) => ({ name, text }))
    return { systemSections, contextSections }
  } catch {
    return undefined
  }
}
