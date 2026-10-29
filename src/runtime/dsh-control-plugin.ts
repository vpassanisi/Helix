import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_CAPABILITIES,
  type ControlRequestEnvelope,
  type ControlSandboxMode,
} from './control-protocol.js'
import { stringValue } from '../shared/value-utils.js'
import { USER_QUESTION_INSTRUCTIONS } from '../shared/user-question.js'
import { MAX_MODEL_SYSTEM_INSTRUCTIONS_CHARACTERS } from './model-catalog.js'
import { DshQuestionBridge } from './dsh-question-bridge.js'
import { DshSkillBridge } from './dsh-skill-bridge.js'
import { ControlTransport } from './dsh-control-transport.js'
import { DshApprovalBridge } from './dsh-approval-bridge.js'
import { DshPreviewCapture } from './dsh-preview-capture.js'
import { DshCommandBridge } from './dsh-command-bridge.js'
import {
  PluginControlError,
  createUserMessage,
  requiredString,
  requireAgent,
} from './dsh-control-shared.js'

const APPROVAL_POLICIES = new Set(['ask', 'never'])
const SANDBOX_MODES = new Set<ControlSandboxMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
])
/** One plain sentence telling the model who wrote the card text beneath it. */
const MODEL_INSTRUCTIONS_HEADER = 'The user provided these instructions directly to you, and customized them for this model.'

/**
 * DSH-side control adapter. It intentionally uses only the runtime services
 * exposed on the Cordis context so the compiled plugin can travel with the
 * extension without shipping a second DSH dependency tree.
 *
 * Composition root: the transport owns the socket, and the bridges own
 * approvals, questions, skills, previews and commands. This file wires them
 * to the DSH context and dispatches Host requests.
 */
export default function helixControlPlugin(ctx: any, config: { cwd?: string } = {}): void {
  const endpoint = process.env.HELIX_CONTROL_ENDPOINT
  const token = process.env.HELIX_CONTROL_TOKEN
  if (!endpoint || !token) return

  const transport = new ControlTransport(endpoint, token, {
    onRequest: (request) => {
      void handleRequest(request)
    },
    onClose: () => {
      questions.disconnect()
      approvals.closeUnavailable()
    },
  })
  const questions = new DshQuestionBridge(ctx, () => transport.isConnected,
    (sessionId, method, params) => transport.sendEvent(sessionId, method, params))
  const approvals = new DshApprovalBridge(() => transport.isConnected,
    (sessionId, method, params) => transport.sendEvent(sessionId, method, params))
  const preview = new DshPreviewCapture(
    (sessionId, method, params) => transport.sendEvent(sessionId, method, params))
  const commands = new DshCommandBridge(
    ctx,
    (request, result, error) => transport.sendResponse(request, result, error),
    (sessionId, method, params) => transport.sendEvent(sessionId, method, params),
  )
  const skills = new DshSkillBridge(ctx, config.cwd ?? process.cwd())

  const reasoningEfforts = new Map<string, string | null>()
  const modelInstructions = new Map<string, string>()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch === 'function') {
    globalThis.fetch = ((input: any, init?: any) => {
      const url = typeof input === 'string' || input instanceof URL
        ? String(input)
        : stringValue(input?.url) ?? String(input)
      const captureSessionId = preview.providerRequestCaptureSessionId
      if (
        captureSessionId !== undefined &&
        init?.method?.toUpperCase() === 'POST' &&
        /\/chat\/completions\/?(?:\?|$)/i.test(url)
      ) {
        preview.providerRequestCaptureSessionId = undefined
        transport.sendEvent(captureSessionId, 'provider.requestCaptured', {
          url,
          body: typeof init.body === 'string' ? init.body : null,
        })
      }
      return originalFetch.call(undefined, input, init)
    }) as typeof fetch
  }

  const handleCapabilities = (request: ControlRequestEnvelope): void => {
    transport.sendResponse(request, { version: CONTROL_PROTOCOL_VERSION, capabilities: CONTROL_CAPABILITIES })
  }

  /**
   * A model card's instructions, staged for the session that selected the model.
   * The Host knows the selection at submit; the prompt assembles per Agent, so the
   * text rides the session and never a global registry.
   */
  const stageModelInstructions = (sessionId: string, params: Record<string, unknown>): void => {
    if (!('instructions' in params)) throw new PluginControlError('Model instructions are required.', 'INVALID_ARGUMENT')
    const instructions = params.instructions
    if (instructions !== null && typeof instructions !== 'string') {
      throw new PluginControlError('Model instructions must be text.', 'INVALID_ARGUMENT')
    }
    const trimmed = typeof instructions === 'string' ? instructions.trim() : ''
    if (trimmed === '') {
      modelInstructions.delete(sessionId)
      return
    }
    if (trimmed.length > MAX_MODEL_SYSTEM_INSTRUCTIONS_CHARACTERS) {
      throw new PluginControlError(`Model instructions exceed ${MAX_MODEL_SYSTEM_INSTRUCTIONS_CHARACTERS} characters.`, 'INVALID_ARGUMENT')
    }
    modelInstructions.set(sessionId, trimmed)
  }

  const onAgentDisposed = ({ agent }: any): void => {
    const sessionId = stringValue(agent?.id)
    if (sessionId !== undefined) modelInstructions.delete(sessionId)
  }

  const handleAgentRequest = (request: ControlRequestEnvelope): void => {
    if (request.method === 'session.setReasoningEffort') {
      const reasoningEffort = request.params.reasoningEffort
      if (reasoningEffort !== null && (typeof reasoningEffort !== 'string' || !reasoningEffort.trim())) {
        throw new PluginControlError('Reasoning effort must be a non-empty ID or null for the model default.', 'INVALID_ARGUMENT')
      }
      reasoningEfforts.set(request.sessionId, reasoningEffort === null ? null : reasoningEffort.trim())
      transport.sendResponse(request, { accepted: true })
      return
    }

    const agent = requireAgent(ctx, request)
    switch (request.method) {
      case 'turn.cancel':
        agent.cancel({ kind: 'user' }, { keepInbox: false })
        transport.sendResponse(request, { accepted: true })
        return
      case 'session.steer':
        agent.steer(createUserMessage(requiredString(request.params.text, 'text')))
        transport.sendResponse(request, { accepted: true })
        return
      case 'session.inject':
        agent.inject(createUserMessage(requiredString(request.params.text, 'text')))
        transport.sendResponse(request, { accepted: true })
        return
      case 'session.setApprovalPolicy': {
        const policy = requiredString(request.params.policy, 'policy')
        if (!APPROVAL_POLICIES.has(policy)) throw new PluginControlError('Approval policy must be ask or never.', 'INVALID_ARGUMENT')
        const approval = ctx.get?.('approval') ?? ctx.approval
        if (approval?.setPolicy === undefined) throw new PluginControlError('Approval policy control is unavailable.', 'CONTROL_REQUEST_FAILED')
        approval.setPolicy(agent, policy)
        transport.sendResponse(request, { accepted: true, policy })
        return
      }
      case 'session.setSandboxMode': {
        const mode = requiredString(request.params.mode, 'mode') as ControlSandboxMode
        if (!SANDBOX_MODES.has(mode)) throw new PluginControlError('Sandbox mode is invalid.', 'INVALID_ARGUMENT')
        agent.session.append('sandbox/mode', { mode })
        transport.sendResponse(request, { accepted: true, mode })
        return
      }
      default:
        throw new PluginControlError(`Unsupported control method ${request.method}.`, 'CONTROL_REQUEST_FAILED')
    }
  }

  const handleRequest = async (request: ControlRequestEnvelope): Promise<void> => {
    try {
      if (request.method === 'skills.catalog') { transport.sendResponse(request, await skills.catalog(request.sessionId)); return }
      if (request.method === 'skills.stage') { await skills.stage(request.sessionId, request.params); transport.sendResponse(request, { accepted: true }); return }
      if (request.method === 'skills.clear') { skills.clear(request.sessionId); transport.sendResponse(request, { accepted: true }); return }
      if (request.method === 'modelInstructions.stage') { stageModelInstructions(request.sessionId, request.params); transport.sendResponse(request, { accepted: true }); return }
      if (request.method === 'modelInstructions.clear') { modelInstructions.delete(request.sessionId); transport.sendResponse(request, { accepted: true }); return }
      if (request.method === 'capabilities.get') return handleCapabilities(request)
      if (request.method === 'approval.resolve') {
        approvals.resolve(request)
        transport.sendResponse(request, { accepted: true })
        return
      }
      if (request.method === 'question.answer') {
        const requestId = stringValue(request.params.questionRequestId)
        if (!requestId) throw new PluginControlError('Question request ID is required.', 'INVALID_ARGUMENT')
        try { questions.answer(request.sessionId, requestId, request.params.answer) }
        catch (error) { throw new PluginControlError(error instanceof Error ? error.message : String(error), 'INVALID_ARGUMENT') }
        transport.sendResponse(request, { accepted: true })
        return
      }
      if (request.method === 'request.preview.arm') {
        preview.arm(request.sessionId, request.params)
        transport.sendResponse(request, { accepted: true })
        return
      }
      if (request.method === 'provider.request.captureNext') {
        preview.captureNextProviderRequest(request.sessionId)
        transport.sendResponse(request, { accepted: true })
        return
      }
      if (request.method === 'commands.catalog') return commands.catalog(request)
      if (request.method === 'session.command') return await commands.run(request)
      handleAgentRequest(request)
    } catch (error) {
      transport.sendResponse(request, undefined, {
        code: error instanceof PluginControlError ? error.code : 'CONTROL_REQUEST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const onAssistantStream = (payload: any): void => {
    const sessionId = stringValue(payload?.agent?.id)
    const frame = payload?.frame
    if (sessionId === undefined || frame === undefined || typeof frame !== 'object' || frame === null) return
    transport.sendEvent(sessionId, 'assistant.stream', { frame })
  }

  const onAgentRequest = async (payload: any, next: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    const sessionId = stringValue(payload?.agent?.id)
    if (sessionId === undefined || !reasoningEfforts.has(sessionId)) return next()

    const config = { ...await next() }
    const reasoningEffort = reasoningEfforts.get(sessionId)
    if (reasoningEffort === null) delete config.reasoningEffort
    else if (reasoningEffort !== undefined) config.reasoningEffort = reasoningEffort
    return config
  }

  const onSystemPromptAssemble = async (
    assembly: any,
    context: any,
    next: () => Promise<any>,
  ): Promise<any> => {
    const sessionId = stringValue(context?.agent?.id)
    const assembled = await skills.assemble(assembly, context, next)
    const instructions = sessionId === undefined ? undefined : modelInstructions.get(sessionId)
    if (Array.isArray(assembled.sections) && instructions !== undefined &&
      !assembled.sections.some((section: any) => section.name === 'helix:model-instructions')) {
      // Literal text: a card may quote braces, and prompt variables are not the user's syntax.
      assembled.sections.push({ name: 'helix:model-instructions', text: `${MODEL_INSTRUCTIONS_HEADER}\n\n${instructions}`, interpolate: false })
    }
    if (Array.isArray(assembled.sections) && !assembled.sections.some((section: any) => section.name === 'helix:user-questions')) {
      assembled.sections.push({ name: 'helix:user-questions', text: USER_QUESTION_INSTRUCTIONS })
    }
    if (sessionId !== undefined) preview.recordPromptBreakdown(assembled, sessionId)
    return assembled
  }

  try {
    ctx.on?.('agent/created', skills.created, { global: true })
    ctx.on?.('agent/disposed', skills.disposed, { global: true })
    ctx.on?.('agent/disposed', onAgentDisposed, { global: true })
    ctx.on?.('agent/pre-step', skills.preStep, { global: true, prepend: true })
    ctx.on?.('skills/change', () => transport.sendEvent('', 'skills.changed', {}))
    ctx.on?.('commands/change', commands.globalChange)
    ctx.on?.('agent/created', commands.agentCreated, { global: true })
    ctx.on?.('tools/execute', questions.execute, { global: true })
    ctx.on?.('user-questions/request', questions.request, { global: true })
    ctx.on?.('approval/request', approvals.request, { global: true })
    ctx.on?.('agent/assistant-stream', onAssistantStream, { global: true })
    ctx.on?.('agent/request', onAgentRequest, { global: true })
    ctx.on?.('system-prompt/assemble', onSystemPromptAssemble, { global: true })
    ctx.on?.('llm/stream', preview.onLlmStream, { global: true })
    ctx.effect?.(() => () => {
      if (originalFetch !== undefined) globalThis.fetch = originalFetch
      transport.dispose()
      questions.dispose()
      skills.dispose()
      approvals.cancelAll()
      preview.clear()
      modelInstructions.clear()
    }, 'helix-control-bridge.lifecycle')
  } catch (error) {
    if (!isInactiveContextError(error)) throw error
    return
  }

  transport.connect()
}

function isInactiveContextError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === 'cannot create effect on inactive context' ||
    (error as { code?: unknown }).code === 'INACTIVE_EFFECT'
  )
}
