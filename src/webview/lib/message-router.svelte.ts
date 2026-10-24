import { mergeHostChanges, recordToolChange, toolChange } from '../../shared/code-changes.js'
import {
  pendingToolKey,
  stringifyPayload,
  toolCallId,
  toolResultCallId,
  toolResultIsError,
  toolResultText,
  toolStepKey,
} from '../../shared/harness-events.js'
import { isRecord, parsePayload, stringValue } from '../../shared/value-utils.js'
import { GEN_UI_TOOL_NAME, parseGenUiCall } from '../../shared/gen-ui.js'
import type { PendingUserQuestion } from '../../shared/user-question.js'
import type { ChatTranscript } from './chat-transcript.svelte.js'
import type { ComposerModelState } from './composer-model.svelte.js'
import type { ComposerCommandState } from './composer-commands.svelte.js'
import type { ModelCatalogState } from './model-catalog.svelte.js'
import type { RequestPreviewState } from './request-preview.svelte.js'
import type { SessionState } from './session-state.svelte.js'
import type { SettingsPageState } from './settings-page.svelte.js'
import type { SkillRoutingState } from './skill-routing.svelte.js'
import type { ToolBundlesState } from './tool-bundles-state.svelte.js'
import type { ApprovalView, HarnessEvent, HarnessNotification, IncomingMessage, SidebarMessage, SidebarSettings } from '../types.js'

export interface MessageRouterDeps {
  post: (message: SidebarMessage) => void
  state: SessionState
  transcript: ChatTranscript
  settingsState: SettingsPageState
  catalog: ModelCatalogState
  composerModel: ComposerModelState
  routing: SkillRoutingState
  commands: ComposerCommandState
  preview: RequestPreviewState
  tools: ToolBundlesState
}

type MessageOfType<T extends IncomingMessage['type']> = Extract<IncomingMessage, { type: T }>
type SettingsMessage = Extract<IncomingMessage, { type: 'settings' | 'settingsSaved' }>
/**
 * Not optional: every wire type must have a handler, so a new
 * `IncomingMessage` variant fails the build until it is wired up here.
 */
type HandlerMap = { [T in IncomingMessage['type']]: (message: MessageOfType<T>) => void }

/**
 * Turns host messages into calls on the state holders. Every branch that
 * belongs to one conversation checks the active session before it acts.
 */
export function createMessageRouter(deps: MessageRouterDeps): (message: IncomingMessage) => void {
  const { post, state, transcript, settingsState, catalog, composerModel, routing, commands, preview, tools } = deps
  const sessionId = () => state.activeSessionId
  const owns = (messageSessionId: string | undefined): boolean => messageSessionId === state.activeSessionId

  function resetTranscript(): void {
    transcript.reset()
    state.streamedStepTracker.reset()
    state.liveToolCallTracker.clear()
    state.resetForSession()
    composerModel.resetForSession()
  }

  function applySettings(next: SidebarSettings): void {
    state.settings = next
    if (!next.skillPickerEnabled) routing.disable()
    composerModel.applySettings(next)
    settingsState.loadConnection(next)
    settingsState.loadMcp(next)
    tools.load(next)
  }

  function handleQuestionRequest(request: PendingUserQuestion): void {
    if (transcript.hasQuestion(request.requestId)) return
    state.beginTurn()
    transcript.upsertToolCall({
      callId: request.toolCallId,
      name: 'ask_user_question',
      arguments: '',
      status: 'running',
      question: { ...request, status: 'pending' },
    })
  }

  function handleApprovalRequest(message: MessageOfType<'approvalRequest'>): void {
    const approval: ApprovalView = { requestId: message.requestId, reason: message.reason, status: 'pending' }
    state.pendingApprovalRequests[message.requestId] = { ...message, approval }
    transcript.attachApproval(message.toolCallId ?? `approval-${message.requestId}`, message.toolName, approval)
  }

  function handleState(message: MessageOfType<'state'>): void {
    const sessionChanged = state.activeSessionId !== message.state.activeSessionId
    const previousRuntimeState = state.runtimeState
    state.activeSessionId = message.state.activeSessionId
    state.runtimeState = message.state.runtimeState
    state.extensionInfo = message.state.extensionInfo
    if (sessionChanged || message.resetTranscript) {
      transcript.finishThinking()
      routing.clearOverrides()
      routing.clearSuggestions()
      routing.clearCatalog()
      commands.clear()
      state.dropPendingSubmission()
      routing.forgetKey()
      composerModel.applyRuntimeEffort(message.state.reasoningEffort)
    }
    if (state.runtimeState === 'stopped' || state.runtimeState === 'error') {
      transcript.finishThinking()
      transcript.interruptCompaction(undefined, state.runtimeState === 'error' ? 'Runtime stopped with an error.' : undefined)
      routing.clearSuggestions()
      state.endTurn()
    }
    if (state.runtimeState === 'starting' && previousRuntimeState === 'ready' && !state.hasPendingSubmission) {
      routing.clearOverrides()
    }
    state.selection = message.state.selection
    state.browserContext = message.state.browserContext
    state.selectionAttached = true
    if (state.runtimeState === 'ready' && settingsState.restarting) {
      settingsState.restarting = false
      composerModel.changing = false
      settingsState.setStatus('Saved. Runtime ready.', 'success')
    } else if (state.runtimeState === 'error' && settingsState.restarting) {
      settingsState.restarting = false
      composerModel.changing = false
      settingsState.setStatus('Runtime failed to restart.', 'warning')
    }
    if (message.resetTranscript) resetTranscript()
    for (const request of message.state.pendingQuestions ?? []) handleQuestionRequest(request)
    if (state.runtimeState === 'stopped' || state.runtimeState === 'error') transcript.endPendingQuestions()
  }

  function handleSettings(message: SettingsMessage): void {
    applySettings(message.settings)
    routing.forgetKey()
    if (message.type !== 'settingsSaved') return
    if (state.skillPickerEnabled) post({ type: 'loadSkills', sessionId: sessionId() })
    settingsState.restarting = message.restarting
    settingsState.mcpSaving = false
    settingsState.setStatus(
      message.restarting
        ? 'Applying settings…'
        : settingsState.page === 'tools'
          ? 'Saved. This session keeps its tools; a new session starts with the saved list.'
          : 'Saved.',
      message.restarting ? 'warning' : 'success',
    )
  }

  function handleCodeChanges(message: MessageOfType<'codeChanges'>): void {
    if (!owns(message.sessionId)) return
    if (message.changes.length > 0) state.waitingForFirstResponse = false
    if (message.active && !state.hostChangesStarted) {
      state.hostChangesStarted = true
      state.codeChanges = []
      state.pendingCodeChanges = {}
      state.toolDerivedPaths = new Set()
    }
    if (message.changes.length > 0) state.codeChanges = mergeHostChanges(state.codeChanges, message.changes)
    if (!message.active) {
      state.hostChangesStarted = false
      void transcript.scrollToBottom()
    }
  }

  function handleAssistantStream(message: MessageOfType<'assistantStream'>): void {
    const frame = isRecord(message.frame) ? message.frame : undefined
    if (frame === undefined) return
    state.streamedStepTracker.recordLiveFrame(message.agentSessionId, frame)
    const update = state.liveToolCallTracker.recordFrame(message.agentSessionId, frame)
    transcript.removePreparingToolCalls(update.discard)
    if (update.prepared !== undefined) {
      const existing = transcript.messages.find((entry) => entry.tool?.callId === update.prepared?.callId)?.tool
      if (existing === undefined || existing.status === 'preparing') {
        transcript.upsertToolCall({ callId: update.prepared.callId, name: update.prepared.name, arguments: '', status: 'preparing' })
      }
    }
    if (frame.type === 'start' || frame.type === 'end') {
      transcript.finishThinking(message.agentSessionId)
      return
    }
    if (frame.type !== 'chunk' || !isRecord(frame.chunk)) return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') transcript.appendStreamText('assistant', chunk.text)
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') transcript.appendStreamText('reasoning', chunk.text, message.agentSessionId)
    if (chunk.type === 'tool-call-delta') transcript.finishThinking(message.agentSessionId)
    if (chunk.type === 'finish' || (chunk.type === 'block-end' && isRecord(chunk.block) && chunk.block.type === 'reasoning')) transcript.finishThinking(message.agentSessionId)
  }

  function handleToolCallEvent(sessionIdValue: string | undefined, data: Record<string, unknown>, rootSession: boolean): void {
    const callId = toolCallId(data, `tool-call-${transcript.allocateId()}`)
    if (sessionIdValue !== undefined) state.liveToolCallTracker.finishCall(sessionIdValue, callId)
    const stepKey = toolStepKey(sessionIdValue, data, state.activeSessionId)
    if (stepKey !== undefined) state.toolCallsByStep[stepKey] = callId
    const toolName = stringValue(data.name)

    // A card the agent drew is its own transcript row, built from the spec in
    // the call's arguments. Not a tool row: the arguments are the content the
    // user reads, not a payload to inspect. Only the conversation the user is
    // reading may put one on screen — a subagent's card has no transcript to
    // land in, and the tool tells that agent so.
    if (toolName === GEN_UI_TOOL_NAME) {
      // Streaming already put a "preparing" row on screen for this call, and the
      // tracker let the id go at the line above, so no later reconcile can
      // collect it. The card row replaces that row; nothing else clears it, and
      // a card with a spinner under it spins for the rest of the session.
      transcript.removePreparingToolCalls([callId])
      if (!rootSession) return
      transcript.finishThinking()
      const call = parseGenUiCall(data.arguments)
      if (call.ok) {
        transcript.appendUi({ callId, spec: call.spec, status: 'rendered', ...(call.title === undefined ? {} : { title: call.title }) })
      } else {
        transcript.appendUi({ callId, spec: { root: '', elements: {} }, status: 'failed', error: call.message })
      }
      return
    }

    const toolArguments = parsePayload(data.arguments)
    const plannedChange = toolName === undefined || toolArguments === undefined
      ? undefined
      : toolChange(toolName, toolArguments)
    const pendingKey = stringValue(data.callId) ?? stepKey
    if (plannedChange !== undefined && pendingKey !== undefined) {
      state.pendingCodeChanges[pendingKey] = plannedChange
    }
    const approval = Object.values(state.pendingApprovalRequests).find((entry) => entry.toolCallId === callId)?.approval
    transcript.upsertToolCall({
      callId,
      name: toolName ?? 'Tool call',
      arguments: typeof data.arguments === 'string' ? data.arguments : stringifyPayload(data.arguments),
      status: 'running',
      ...(approval === undefined ? {} : { approval }),
    })
  }

  function handleToolResultEvent(sessionIdValue: string | undefined, data: Record<string, unknown>): void {
    const resultMessage = isRecord(data.message) ? data.message : {}
    const resultContent = resultMessage.content
    const link = { data, message: resultMessage, sessionId: sessionIdValue, callsByStep: state.toolCallsByStep, activeSessionId: state.activeSessionId }
    const error = isRecord(data.error)
      ? [stringValue(data.error.name), stringValue(data.error.code)].filter(Boolean).join(': ')
      : toolResultIsError(resultContent) ? 'Tool reported an error.' : undefined
    const meta = data.meta === undefined ? undefined : stringifyPayload(data.meta)
    const callId = toolResultCallId(link, `tool-result-${transcript.allocateId()}`)
    // A card owns its content already, so its result is only a status: the
    // plugin's rejection text lands on the card the user can see, not in a
    // tool row that would bury it.
    if (transcript.hasUi(callId)) {
      transcript.removePreparingToolCalls([callId])
      transcript.updateUi(callId, error === undefined
        ? { status: 'rendered', error: undefined }
        : { status: 'failed', error: toolResultText(resultContent) || error })
      return
    }
    if (sessionIdValue !== undefined) state.liveToolCallTracker.finishCall(sessionIdValue, callId)
    const pendingKey = pendingToolKey(link)
    const plannedChange = pendingKey === undefined ? undefined : state.pendingCodeChanges[pendingKey]
    if (pendingKey !== undefined) delete state.pendingCodeChanges[pendingKey]
    if (plannedChange !== undefined && !error) {
      state.codeChanges = recordToolChange(state.codeChanges, state.toolDerivedPaths, {
        ...plannedChange,
        kind: plannedChange.kind === 'modified' && /created file/i.test(toolResultText(resultContent))
          ? 'created'
          : plannedChange.kind,
      })
    }
    transcript.updateToolResult(callId, toolResultText(resultContent), error || undefined, meta)
  }

  function handleSessionEvent(params: Record<string, unknown>, event: HarnessEvent): void {
    const data = isRecord(event.data) ? event.data : {}
    const isRootSessionEvent = params.sessionId === state.activeSessionId
    const sessionIdValue = stringValue(params.sessionId)

    if (sessionIdValue !== undefined && event.type !== undefined) {
      const compaction = transcript.compactionHistory.record(sessionIdValue, event.type, data)
      if (compaction) {
        if (isRootSessionEvent) composerModel.clearUsage()
        state.waitingForFirstResponse = false
        transcript.finishThinking(sessionIdValue)
        transcript.updateCompaction(compaction)
        return
      }
      if (event.type === 'turn/end') transcript.interruptCompaction(sessionIdValue)
    }

    if (event.type === 'plan/mode') {
      if (isRootSessionEvent) transcript.appendPlanRule(data.active !== false)
      return
    }

    if (event.type === 'request/context') {
      if (isRootSessionEvent) composerModel.updateContextWindow(data.contextWindow)
      return
    }

    if (event.type === 'assistant/chunk') {
      const chunk = isRecord(data.chunk) ? data.chunk : undefined
      state.streamedStepTracker.recordDurableChunk(sessionIdValue, data)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') transcript.appendStreamText('assistant', chunk.text)
      if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') transcript.appendStreamText('reasoning', chunk.text, sessionIdValue ?? state.activeSessionId)
      if (chunk?.type === 'tool-call-delta') transcript.finishThinking(sessionIdValue)
      if (chunk?.type === 'finish' || (chunk?.type === 'block-end' && isRecord(chunk.block) && chunk.block.type === 'reasoning')) transcript.finishThinking(sessionIdValue)
      if (isRootSessionEvent && chunk?.type === 'usage') composerModel.recordUsage(chunk.usage)
      return
    }

    if (event.type === 'assistant/message') {
      transcript.finishThinking(sessionIdValue)
      if (sessionIdValue !== undefined) transcript.removePreparingToolCalls(state.liveToolCallTracker.reconcileMessage(sessionIdValue, data))
      if (isRootSessionEvent) composerModel.recordUsage(data.usage)
      if (!state.streamedStepTracker.hasStreamedStep(sessionIdValue, data)) {
        const message = isRecord(data.message) ? data.message : {}
        transcript.appendAssistantBlocks(message.content)
      }
      return
    }

    if (event.type === 'assistant/attempt') {
      transcript.finishThinking(sessionIdValue)
      if (sessionIdValue !== undefined) transcript.removePreparingToolCalls(state.liveToolCallTracker.clearStep(sessionIdValue, data))
      return
    }

    if (event.type === 'tool/call') {
      handleToolCallEvent(sessionIdValue, data, isRootSessionEvent)
      return
    }

    if (event.type === 'tool/result') handleToolResultEvent(sessionIdValue, data)
  }

  function handleStatusNotification(params: Record<string, unknown>): void {
    const statusSessionId = stringValue(params.sessionId)
    if (statusSessionId !== state.activeSessionId) {
      if (statusSessionId !== undefined && params.status !== 'running') {
        transcript.interruptCompaction(statusSessionId)
        transcript.removePreparingToolCalls(state.liveToolCallTracker.clear(statusSessionId))
      }
      return
    }
    if (params.status === 'running') {
      state.beginTurn()
    } else {
      transcript.interruptCompaction(state.activeSessionId)
      transcript.removePreparingToolCalls(state.liveToolCallTracker.clear())
      transcript.finishThinking()
      state.endTurn()
      if (state.codeChanges.length > 0) void transcript.scrollToBottom()
    }
  }

  function handleNotification(value: unknown): void {
    if (!isRecord(value)) return
    const notification = value as HarnessNotification
    const params = isRecord(notification.params) ? notification.params : {}

    if (notification.method === 'session.status') {
      handleStatusNotification(params)
      return
    }

    if (notification.method === 'subagent.started') {
      state.waitingForFirstResponse = false
      transcript.appendMessage('activity', 'Subagent', `Started ${String(params.childSessionId || 'child session')}`)
      return
    }

    if (notification.method === 'subagent.finished') {
      const childSessionId = stringValue(params.childSessionId)
      if (childSessionId !== undefined) transcript.interruptCompaction(childSessionId)
      if (childSessionId !== undefined) transcript.removePreparingToolCalls(state.liveToolCallTracker.clear(childSessionId))
      transcript.appendMessage('activity', 'Subagent', `Finished ${String(params.childSessionId || 'child session')}`)
      return
    }

    if (notification.method !== 'session.event' || !isRecord(params.event)) return
    handleSessionEvent(params, params.event as HarnessEvent)
  }

  const handlers: HandlerMap = {
    skillsInvalidated: () => routing.invalidate(),
    skillCatalog: (message) => {
      if (!state.skillPickerEnabled || !owns(message.sessionId)) return
      routing.applyCatalog(message.catalog, message.error)
    },
    skillSuggestions: (message) => routing.applySuggestions(message.suggestions, state.skillPickerEnabled, state.activeSessionId),
    commandCatalog: (message) => {
      if (!owns(message.sessionId)) return
      commands.applyCatalog(message.catalog, message.error)
    },
    commandResult: (message) => {
      if (!owns(message.sessionId)) return
      // A successful `/plan` is written as the rule that crosses the transcript
      // when the mode changes; the card would only repeat it.
      if (message.name === 'plan' && message.kind === 'success') return
      transcript.appendMessage('activity', `Command ${message.kind === 'success' ? 'ran' : 'failed'}`,
        message.text ?? (message.kind === 'success' ? `/${message.name} finished.` : `/${message.name} did not finish.`))
    },
    submitFailed: (message) => {
      if (!owns(message.sessionId)) return
      if (state.pendingSubmission) {
        state.prompt = state.pendingSubmission.text
        transcript.discardMessage(state.pendingSubmission.userId)
      }
      state.dropPendingSubmission()
      state.endTurn()
      routing.forgetKey()
      transcript.appendMessage('activity', 'Submission', message.message)
    },
    state: handleState,
    selection: (message) => {
      state.selection = message.selection
      state.selectionAttached = true
    },
    browserContext: (message) => {
      if (!owns(message.state.sessionId)) return
      state.browserContext = message.state
    },
    browserSubmitFailed: (message) => {
      if (!owns(message.sessionId)) return
      state.endTurn()
      if (state.browserContext) state.browserContext = { ...state.browserContext, message: message.message }
    },
    codeChanges: handleCodeChanges,
    settings: handleSettings,
    settingsSaved: handleSettings,
    discoveredModels: (message) => catalog.applyDiscovered(message.models, message.error),
    modelCatalog: (message) => {
      catalog.applyCatalog(message.models, message.error)
      composerModel.applyReasoningHistory(message.reasoningHistory)
      composerModel.applyCatalogContextWindow()
      composerModel.syncEffortWithCatalog()
    },
    modelCatalogSaved: (message) => {
      catalog.applySaved(message.models)
      composerModel.applyReasoningHistory(message.reasoningHistory)
      composerModel.syncEffortWithCatalog()
      settingsState.setStatus(
        message.runtimeRestarting ? 'Models saved. Applying model settings…' : 'Models saved.',
        message.runtimeRestarting ? 'warning' : 'success',
      )
    },
    requestPreviewState: (message) => preview.apply(message),
    questionRequest: (message) => {
      if (owns(message.request.sessionId)) handleQuestionRequest(message.request)
    },
    questionResolved: (message) => {
      if (!owns(message.sessionId)) return
      transcript.updateQuestion(message.requestId, { status: message.status, answer: message.answer, error: undefined })
    },
    questionAnswerFailed: (message) => {
      if (!owns(message.sessionId)) return
      transcript.updateQuestion(message.requestId, { status: 'pending', error: message.message })
    },
    approvalRequest: (message) => {
      if (!owns(message.sessionId)) return
      state.waitingForFirstResponse = false
      handleApprovalRequest(message)
    },
    approvalResolved: (message) => {
      if (!owns(message.sessionId)) return
      transcript.updateToolApproval(message.requestId, message.outcome)
    },
    notification: (message) => {
      // The extension host routes notifications before they reach this Webview.
      // Keep this exact-session guard as a second isolation boundary.
      if (!owns(message.sessionId)) return
      handleNotification(message.notification)
    },
    assistantStream: (message) => {
      if (!owns(message.sessionId)) return
      handleAssistantStream(message)
    },
    error: (message) => {
      transcript.interruptCompaction(undefined, message.message)
      transcript.removePreparingToolCalls(state.liveToolCallTracker.clear())
      state.endTurn()
      settingsState.restarting = false
      catalog.catalogSaving = false
      settingsState.mcpSaving = false
      composerModel.changing = false
      if (settingsState.page !== undefined) settingsState.setStatus(message.message, 'warning')
      else transcript.appendMessage('activity', 'Runtime error', message.message)
    },
    accepted: (message) => {
      if (!owns(message.sessionId)) return
      if (state.pendingSubmission && state.prompt.trim() === state.pendingSubmission.text) state.prompt = ''
      state.dropPendingSubmission()
      routing.resetForTurn()
      state.beginTurn()
      composerModel.applyModelChanged(message.modelId, message.reasoningEffort)
    },
  }

  return (message: IncomingMessage) => {
    const handler = handlers[message.type] as (message: IncomingMessage) => void
    handler(message)
  }
}
