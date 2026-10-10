<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import {
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    Brain,
    Check,
    ChevronDown,
    Code2,
    MousePointer2,
    FileDiff,
    LoaderCircle,
    Plus,
    RefreshCw,
    Server,
    Square,
    Trash2,
    Wrench,
    X,
  } from '@lucide/svelte'
  import { renderMarkdown } from './markdown.js'
  import { LiveToolCallTracker } from '../shared/live-tool-call-tracker.js'
  import { StreamedStepTracker } from '../shared/streamed-step-tracker.js'
  import { createRequestPreviewView } from '../shared/request-preview-view.js'
  import { CompactionHistory, type CompactionEntry } from '../shared/compaction-history.js'
  import CompactionCard from './components/CompactionCard.svelte'
  import AboutSettings from './components/AboutSettings.svelte'
  import type { ExtensionInfo } from '../shared/extension-info.js'
  import {
    DSH_REASONING_FORMATS,
    DSH_REASONING_LEVELS,
    isBinaryReasoningFormat,
    preferredReasoningEffort,
    selectableReasoningEfforts,
    updateReasoningEffortSelection,
    type ChatTemplateValue,
    type ReasoningFormat,
  } from '../runtime/model-catalog.js'
  import SkillsDrawer from './components/SkillsDrawer.svelte'
  import DecisionSettingsPanel from './components/DecisionSettings.svelte'
  import { DEFAULT_DECISION_SETTINGS, recentChatContext, type DecisionSettings, type SkillCatalog, type SkillDraft, type SkillOverrides, type SkillSuggestions } from '../shared/skills.js'
  import Masthead from './components/Masthead.svelte'
  import BrowserAttachments from './components/BrowserAttachments.svelte'
  import UserQuestionCard from './components/UserQuestionCard.svelte'
  import { validateQuestionAnswer, type PendingUserQuestion, type UserQuestionAnswer, type UserQuestionView } from '../shared/user-question.js'
  import type { BrowserContextState } from '../shared/browser-context.js'
  import { countLines, isRecord, parsePayload, responseKey, stringValue } from '../shared/value-utils.js'
  import type {
    HarnessEvent,
    HarnessNotification,
    IncomingMessage,
    CodeChange,
    RuntimeState,
    SelectionMetadata,
    SandboxMode,
    SidebarMessage,
    SidebarMcpEnvironment,
    SidebarMcpServer,
    SidebarMcpServerSetting,
    SidebarDiscoveredModel,
    SidebarModel,
    RequestPreviewResult,
    ModelDraft,
    SidebarSettings,
    SettingsPage,
    WebviewApi,
  } from './types.js'

  interface Props {
    vscode: WebviewApi
  }

  interface ChatMessage {
    id: number
    role: 'user' | 'assistant' | 'reasoning' | 'activity' | 'tool' | 'compaction'
    label: string
    text: string
    context?: SelectionMetadata
    browserLabels?: string[]
    tool?: ToolCallView
    compaction?: CompactionEntry
  }

  interface ToolCallView {
    callId: string
    name: string
    arguments: string
    result?: string
    meta?: string
    error?: string
    status: 'preparing' | 'running' | 'completed' | 'error'
    approval?: ApprovalView
    question?: UserQuestionView
  }

  interface ApprovalView {
    requestId: string
    reason?: string
    status: 'pending' | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    decisionPending?: boolean
  }

  interface StreamUpdate {
    role: 'assistant' | 'reasoning'
    text: string
  }

  interface McpEnvironmentDraft {
    name: string
    value: string
    configured: boolean
  }

  interface McpServerDraft {
    serverName: string
    transport: 'stdio' | 'streamable-http'
    command: string
    argsText: string
    url: string
    env: McpEnvironmentDraft[]
  }

  interface ModelEditorDraft extends Omit<SidebarModel, 'reasoningEfforts' | 'chatTemplateKwargs' | 'chatTemplateArgs'> {
    key: number
    sourceId?: string
    reasoningEfforts: string[]
    chatTemplateKwargsText: string
    chatTemplateArgsText: string
  }
  const reasoningFormatOptions: ReasoningFormat[] = ['auto', ...DSH_REASONING_FORMATS]

  let { vscode }: Props = $props()

  let activeSessionId = $state('')
  let runtimeState = $state<RuntimeState>('stopped')
  let selection = $state<SelectionMetadata | undefined>()
  let selectionAttached = $state(true)
  let messages = $state<ChatMessage[]>([])
  const compactionHistory = new CompactionHistory()
  let prompt = $state('')
  let decisions = $state<DecisionSettings>({ ...DEFAULT_DECISION_SETTINGS })
  let decisionsApiKey = $state('')
  let clearDecisionsApiKey = $state(false)
  let skillCatalog = $state<SkillCatalog>({ skills: [], revision: '', complete: false })
  let skillError = $state('')
  let skillSuggestions = $state<SkillSuggestions>()
  let skillOverrides = $state<SkillOverrides>({ include: [], exclude: [] })
  let draftRevision = $state(0)
  let lastAnalyzed = ''
  let routingEpoch = $state(0)
  let pendingSubmission = $state<{ text: string; userId: number }>()
  let settings = $state<SidebarSettings | undefined>()
  const skillPickerEnabled = $derived(settings?.skillPickerEnabled === true)

  $effect(() => {
    if (!skillPickerEnabled) return
    const sessionId = activeSessionId
    if (sessionId) post({ type: 'loadSkills', sessionId })
  })

  function skillDraft(text = prompt.trim()): SkillDraft {
    return { sessionId: activeSessionId, revision: draftRevision, prompt: text,
      recentChat: recentChatContext(messages.filter((entry) => entry.role === 'user' || entry.role === 'assistant')
        .map((entry) => ({ role: entry.role as 'user' | 'assistant', text: entry.text }))) }
  }
  $effect(() => {
    if (!skillPickerEnabled || !activeSessionId || isGenerating || pendingSubmission) return
    const draft = untrack(() => skillDraft())
    draft.prompt = prompt.trim()
    const key = JSON.stringify([draft.sessionId, draft.prompt, draft.recentChat, skillCatalog.revision, settings?.decisions, selection?.languageId, routingEpoch])
    if (key === lastAnalyzed) return
    lastAnalyzed = key
    draft.revision = untrack(() => ++draftRevision)
    skillSuggestions = { sessionId: draft.sessionId, revision: draft.revision, selected: [], probabilities: {}, status: draft.prompt ? 'checking' : 'disabled' }
    post({ type: 'analyzeSkills', draft })
  })
  let isGenerating = $state(false)
  let activeThinkingId = $state<number>()
  let activeThinkingSessionId: string | undefined
  let waitingForFirstResponse = $state(false)
  let settingsPage = $state<SettingsPage | undefined>()
  let extensionInfo = $state<ExtensionInfo | undefined>()
  let provider = $state('')
  let model = $state('')
  let reasoningEffort = $state<string | null>(null)
  let reasoningHistory = $state<Record<string, string>>({})
  let baseUrl = $state('')
  let apiKey = $state('')
  let sandboxMode = $state<SandboxMode>('workspace-write')
  let clearApiKey = $state(false)
  let settingsStatus = $state('')
  let settingsStatusTone = $state<'success' | 'warning' | ''>('')
  let requestPreviewPrompt = $state('')
  let requestPreviewState = $state<'idle' | 'loading' | 'success' | 'error' | 'cancelled'>('idle')
  let requestPreview = $state<RequestPreviewResult | undefined>()
  let showRawRequestJson = $state(false)
  let requestPreviewError = $state('')
  let settingsRestarting = $state(false)
  let mcpSaving = $state(false)
  let contextUsedTokens = $state<number | undefined>()
  let contextWindowTokens = $state<number | undefined>()
  let contextWindowOverride = $state<number | undefined>()
  let modelChanging = $state(false)
  let models = $state<SidebarModel[]>([])
  let discoveredModels = $state<SidebarDiscoveredModel[]>([])
  let modelDrafts = $state<ModelEditorDraft[]>([])
  let modelsLoading = $state(false)
  let modelsError = $state('')
  let modelCatalogLoading = $state(true)
  let modelCatalogSaving = $state(false)
  let modelCatalogError = $state('')
  let mcpServers = $state<McpServerDraft[]>([])
  let codeChanges = $state<CodeChange[]>([])
  let changesOpen = $state(false)
  let hostChangesStarted = false
  let nextMessageId = 1
  let transcriptElement = $state<HTMLDivElement>()
  let followTranscript = true
  let promptElement = $state<HTMLTextAreaElement>()
  let modelSourcePickerElement = $state<HTMLDivElement>()
  let sandboxPickerElement = $state<HTMLDivElement>()
  let effortStateNeedsCatalog = false
  const streamedStepTracker = new StreamedStepTracker()
  const liveToolCallTracker = new LiveToolCallTracker()
  let toolCallsByStep: Record<string, string> = {}
  let pendingCodeChanges: Record<string, CodeChange> = {}
  let pendingApprovalRequests: Record<string, Extract<IncomingMessage, { type: 'approvalRequest' }> & { approval: ApprovalView }> = {}
  let toolDerivedPaths = new Set<string>()
  let nextModelDraftKey = 1
  let browserContext = $state<BrowserContextState | undefined>()
  const waitingForAnswer = $derived(messages.some((message) => message.tool?.question?.status === 'pending' || message.tool?.question?.status === 'submitting'))

  onMount(() => {
    const listener = (event: MessageEvent<IncomingMessage>) => handleMessage(event.data)
    window.addEventListener('message', listener)
    vscode.postMessage({ type: 'ready' })
    post({ type: 'loadModelCatalog' })
    void tick().then(initializeSandboxPicker)

    return () => {
      window.removeEventListener('message', listener)
    }
  })

  function post(message: SidebarMessage): void {
    vscode.postMessage(message)
  }

  function handleMessage(message: IncomingMessage): void {
    if (message.type === 'skillsInvalidated') { routingEpoch++; skillSuggestions = undefined; return }
    if (message.type === 'skillCatalog') {
      if (!skillPickerEnabled || message.sessionId !== activeSessionId) return
      skillCatalog = message.catalog
      skillError = message.error ?? ''
      return
    }
    if (message.type === 'skillSuggestions') {
      if (skillPickerEnabled && message.suggestions.sessionId === activeSessionId && message.suggestions.revision === draftRevision) skillSuggestions = message.suggestions
      return
    }
    if (message.type === 'submitFailed') {
      if (message.sessionId !== activeSessionId) return
      if (pendingSubmission) {
        prompt = pendingSubmission.text
        messages = messages.filter((entry) => entry.id !== pendingSubmission?.userId)
      }
      pendingSubmission = undefined
      isGenerating = false
      waitingForFirstResponse = false
      lastAnalyzed = ''
      appendMessage('activity', 'Submission', message.message)
      return
    }
    if (message.type === 'state') {
      const sessionChanged = activeSessionId !== message.state.activeSessionId
      const previousRuntimeState = runtimeState
      activeSessionId = message.state.activeSessionId
      runtimeState = message.state.runtimeState
      extensionInfo = message.state.extensionInfo
      if (sessionChanged || message.resetTranscript) {
        finishThinking()
        skillOverrides = { include: [], exclude: [] }
        skillSuggestions = undefined
        skillCatalog = { skills: [], revision: '', complete: false }
        pendingSubmission = undefined
        lastAnalyzed = ''
        reasoningEffort = message.state.reasoningEffort ?? preferredEffortForModel(model)
        effortStateNeedsCatalog = message.state.reasoningEffort === undefined && !models.some((entry) => entry.id === model)
      }
      if (runtimeState === 'stopped' || runtimeState === 'error') {
        finishThinking()
        interruptCompaction(undefined, runtimeState === 'error' ? 'Runtime stopped with an error.' : undefined)
        skillSuggestions = undefined
        isGenerating = false
        waitingForFirstResponse = false
      }
      if (runtimeState === 'starting' && previousRuntimeState === 'ready' && !pendingSubmission) {
        skillOverrides = { include: [], exclude: [] }
      }
      selection = message.state.selection
      browserContext = message.state.browserContext
      selectionAttached = true
      if (runtimeState === 'ready' && settingsRestarting) {
        settingsRestarting = false
        modelChanging = false
        setSettingsStatus('Saved. Runtime ready.', 'success')
      }
      if (message.resetTranscript) {
        resetTranscript()
      }
      for (const request of message.state.pendingQuestions ?? []) handleQuestionRequest(request)
      if (runtimeState === 'stopped' || runtimeState === 'error') endPendingQuestions()
      return
    }

    if (message.type === 'selection') {
      selection = message.selection
      selectionAttached = true
      return
    }

    if (message.type === 'browserContext') {
      if (message.state.sessionId === activeSessionId) browserContext = message.state
      return
    }
    if (message.type === 'browserSubmitFailed') {
      if (message.sessionId !== activeSessionId) return
      isGenerating = false
      waitingForFirstResponse = false
      if (browserContext) browserContext = { ...browserContext, message: message.message }
      return
    }

    if (message.type === 'codeChanges') {
      if (message.sessionId !== activeSessionId) return
      if (message.changes.length > 0) waitingForFirstResponse = false
      if (message.active && !hostChangesStarted) {
        hostChangesStarted = true
        codeChanges = []
        pendingCodeChanges = {}
        toolDerivedPaths = new Set()
      }
      if (message.changes.length > 0) codeChanges = mergeHostChanges(codeChanges, message.changes)
      if (!message.active) {
        hostChangesStarted = false
        void scrollToBottom()
      }
      return
    }

    if (message.type === 'settings' || message.type === 'settingsSaved') {
      applySettings(message.settings)
      lastAnalyzed = ''
      if (message.type === 'settingsSaved' && skillPickerEnabled) post({ type: 'loadSkills', sessionId: activeSessionId })
      if (message.type === 'settingsSaved') {
        settingsRestarting = message.restarting
        mcpSaving = false
        setSettingsStatus(
          message.restarting ? 'Applying settings…' : 'Saved.',
          message.restarting ? 'warning' : 'success',
        )
      }
      return
    }

    if (message.type === 'discoveredModels') {
      discoveredModels = message.models
      modelsLoading = false
      modelsError = message.error ?? ''
      void tick().then(refreshModelSourcePicker)
      return
    }

    if (message.type === 'modelCatalog') {
      models = message.models
      reasoningHistory = message.reasoningHistory
      modelDrafts = message.models.map(toModelEditorDraft)
      modelCatalogLoading = false
      modelCatalogError = message.error ?? ''
      const selected = models.find((option) => option.id === model)
      if (selected?.contextWindow !== undefined) {
        contextWindowOverride = selected.contextWindow
        contextWindowTokens = selected.contextWindow
      }
      syncReasoningEffortWithCatalog()
      void tick().then(initializeReasoningEffortPicker)
      void tick().then(refreshModelSourcePicker)
      return
    }

    if (message.type === 'modelCatalogSaved') {
      models = message.models
      reasoningHistory = message.reasoningHistory
      modelDrafts = message.models.map(toModelEditorDraft)
      modelCatalogSaving = false
      modelCatalogError = ''
      syncReasoningEffortWithCatalog()
      setSettingsStatus(
        message.runtimeRestarting ? 'Models saved. Applying model settings…' : 'Models saved.',
        message.runtimeRestarting ? 'warning' : 'success',
      )
      void tick().then(initializeReasoningEffortPicker)
      void tick().then(refreshModelSourcePicker)
      return
    }

    if (message.type === 'requestPreviewState') {
      requestPreviewState = message.state
      requestPreview = message.preview
      requestPreviewError = message.message ?? ''
      return
    }

    if (message.type === 'questionRequest') {
      if (message.request.sessionId === activeSessionId) handleQuestionRequest(message.request)
      return
    }
    if (message.type === 'questionResolved') {
      if (message.sessionId !== activeSessionId) return
      updateQuestion(message.requestId, { status: message.status, answer: message.answer, error: undefined })
      return
    }
    if (message.type === 'questionAnswerFailed') {
      if (message.sessionId !== activeSessionId) return
      updateQuestion(message.requestId, { status: 'pending', error: message.message })
      return
    }
    if (message.type === 'approvalRequest') {
      if (message.sessionId !== activeSessionId) return
      waitingForFirstResponse = false
      handleApprovalRequest(message)
      return
    }

    if (message.type === 'approvalResolved') {
      if (message.sessionId !== activeSessionId) return
      updateToolApproval(message.requestId, message.outcome)
      return
    }

    if (message.type === 'notification') {
      // The extension host routes notifications before they reach this Webview.
      // Keep this exact-session guard as a second isolation boundary.
      if (message.sessionId !== activeSessionId) return
      handleNotification(message.notification)
      return
    }

    if (message.type === 'assistantStream') {
      if (message.sessionId !== activeSessionId) return
      handleAssistantStream(message)
      return
    }

    if (message.type === 'error') {
      interruptCompaction(undefined, message.message)
      removePreparingToolCalls(liveToolCallTracker.clear())
      isGenerating = false
      waitingForFirstResponse = false
      settingsRestarting = false
      modelCatalogSaving = false
      mcpSaving = false
      modelChanging = false
      if (settingsPage !== undefined) {
        setSettingsStatus(message.message, 'warning')
      }
      else appendMessage('activity', 'Runtime error', message.message)
      return
    }

    if (message.type === 'accepted' && message.sessionId === activeSessionId) {
      if (pendingSubmission && prompt.trim() === pendingSubmission.text) prompt = ''
      pendingSubmission = undefined
      skillOverrides = { include: [], exclude: [] }
      skillSuggestions = undefined
      lastAnalyzed = ''
      isGenerating = true
      if (message.reasoningEffort !== undefined && selectedEffortsForModel(message.modelId).includes(message.reasoningEffort)) {
        reasoningHistory = { ...reasoningHistory, [message.modelId]: message.reasoningEffort }
      }
      if (model === message.modelId) reasoningEffort = message.reasoningEffort ?? null
      effortStateNeedsCatalog = false
    }
  }

  function applySettings(next: SidebarSettings): void {
    settings = next
    if (!next.skillPickerEnabled) {
      skillOverrides = { include: [], exclude: [] }
      skillSuggestions = undefined
      skillCatalog = { skills: [], revision: '', complete: false }
      skillError = ''
    }
    provider = next.provider
    if (model !== next.model) {
      model = next.model
      reasoningEffort = preferredEffortForModel(model)
      effortStateNeedsCatalog = !models.some((entry) => entry.id === model)
    }
    const selected = models.find((option) => option.id === next.model)
    contextWindowOverride = selected?.contextWindow ?? (next.contextWindow > 0 ? next.contextWindow : undefined)
    contextWindowTokens = contextWindowOverride
    baseUrl = next.baseUrl
    sandboxMode = next.sandboxMode
    apiKey = ''
    clearApiKey = false
    decisions = { ...DEFAULT_DECISION_SETTINGS, ...next.decisions }
    decisionsApiKey = ''
    clearDecisionsApiKey = false
    mcpServers = next.mcpServers.map(toMcpServerDraft)
  }

  function toModelEditorDraft(entry: SidebarModel): ModelEditorDraft {
    const { reasoningEfforts, chatTemplateKwargs, chatTemplateArgs, ...modelEntry } = entry
    return {
      ...modelEntry,
      key: nextModelDraftKey++,
      sourceId: entry.id,
      acceptsImages: entry.acceptsImages ?? false,
      reasoningFormat: entry.reasoningFormat ?? 'auto',
      binaryThinkingMode: entry.binaryThinkingMode ?? 'on',
      reasoningEfforts: reasoningEfforts ?? [],
      chatTemplateKwargsText: JSON.stringify(chatTemplateKwargs ?? {}, null, 2),
      chatTemplateArgsText: JSON.stringify(chatTemplateArgs ?? {}, null, 2),
    }
  }

  function toMcpServerDraft(server: SidebarMcpServerSetting): McpServerDraft {
    return {
      serverName: server.serverName,
      transport: server.transport,
      command: server.command,
      argsText: server.args.join('\n'),
      url: server.url,
      env: server.env.map((entry) => ({ name: entry.name, value: '', configured: entry.configured })),
    }
  }

  function resetTranscript(): void {
    finishThinking()
    compactionHistory.reset()
    followTranscript = true
    streamedStepTracker.reset()
    liveToolCallTracker.clear()
    toolCallsByStep = {}
    pendingCodeChanges = {}
    toolDerivedPaths = new Set()
    pendingApprovalRequests = {}
    messages = []
    codeChanges = []
    changesOpen = false
    hostChangesStarted = false
    isGenerating = false
    waitingForFirstResponse = false
    contextUsedTokens = undefined
    contextWindowTokens = contextWindowOverride
  }

  function setSettingsStatus(text: string, tone: 'success' | 'warning' | ''): void {
    settingsStatus = text
    settingsStatusTone = tone
  }

  function selectionLineLabel(value: SelectionMetadata): string {
    return value.ranges
      .map((range) => range.startLine === range.endLine
        ? `L${range.startLine}`
        : `L${range.startLine}–L${range.endLine}`)
      .join(', ')
  }

  function submit(): void {
    if (isGenerating || waitingForAnswer) {
      finishThinking()
      interruptCompaction()
      waitingForFirstResponse = false
      skillOverrides = { include: [], exclude: [] }
      skillSuggestions = undefined
      lastAnalyzed = ''
      post({ type: 'cancelTurn' })
      return
    }

    const text = prompt.trim()
    if (!text) return

    const routingDraft = skillDraft(text)
    const attachedSelection = selectionAttached ? selection : undefined
    const browserAttachments = browserContext?.attachments ?? []
    const userId = nextMessageId
    appendMessage('user', 'You', text, attachedSelection, browserAttachments.map((attachment) => attachment.label))
    pendingSubmission = { text, userId }
    isGenerating = true
    waitingForFirstResponse = true
    post({
      type: 'submit',
      prompt: text,
      includeSelection: attachedSelection !== undefined,
      reasoningEffort,
      sessionId: activeSessionId,
      browserAttachmentIds: browserAttachments.map((attachment) => attachment.id),
      ...(skillPickerEnabled ? { skillDraft: routingDraft,
        skillOverrides: { include: [...skillOverrides.include], exclude: [...skillOverrides.exclude] } } : {}),
    })
    selectionAttached = true
    void tick().then(() => promptElement?.focus())
  }

  function startNewSession(): void {
    waitingForFirstResponse = false
    post({ type: 'newSession' })
  }

  function handlePromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      if (waitingForAnswer) return
      submit()
    }
  }

  function refreshModels(): void {
    modelsLoading = true
    modelsError = ''
    post({ type: 'refreshModels' })
  }

  function handleComposerModelSelection(nextModel: string): void {
    if (!nextModel) return

    const selected = models.find((option) => option.id === nextModel)
    const selectedContextWindow = selected?.contextWindow
    model = nextModel
    reasoningEffort = preferredEffortForModel(nextModel)
    effortStateNeedsCatalog = false
    contextWindowOverride = selectedContextWindow
    contextWindowTokens = selectedContextWindow
    modelChanging = true
    post({ type: 'selectModel', model: nextModel })
  }

  function handleAddDiscoveredModel(event: Event): void {
    const detail = (event as CustomEvent<{ value?: string }>).detail
    const selectedId = typeof detail?.value === 'string' ? detail.value : ''
    if (!selectedId) return

    const discovered = discoveredModels.find((entry) => entry.id === selectedId)
    if (discovered === undefined) return

    const existing = modelDrafts.find((entry) => entry.id === discovered.id)
    if (existing !== undefined) {
      setSettingsStatus(`Model "${existing.displayName || existing.id}" is already in the catalog.`, 'warning')
    } else {
      const { loaded: _loaded, reasoningEfforts, ...modelEntry } = discovered
      modelDrafts = [{
        ...modelEntry,
        key: nextModelDraftKey++,
        acceptsImages: false,
        reasoningEfforts: reasoningEfforts ?? [],
        reasoningFormat: 'auto',
        binaryThinkingMode: 'on',
        chatTemplateKwargsText: '{}',
        chatTemplateArgsText: '{}',
      }, ...modelDrafts]
      setSettingsStatus(`Added ${discovered.displayName ?? discovered.id}. Edit its details, then save models.`, 'success')
    }
    const picker = modelSourcePickerElement as (HTMLDivElement & { clear?: () => void }) | undefined
    picker?.clear?.()
    void tick().then(() => {
      initializeReasoningEffortPicker()
      refreshModelSourcePicker()
    })
  }

  function removeModelDraft(key: number): void {
    modelDrafts = modelDrafts.filter((draft) => draft.key !== key)
  }

  function modelEffortOptions(draft: ModelEditorDraft): string[] {
    return [...draft.reasoningEfforts]
  }

  function modelReasoningEffortChoices(draft: ModelEditorDraft): string[] {
    const legacy = draft.reasoningEfforts.filter((effort) => !(DSH_REASONING_LEVELS as readonly string[]).includes(effort))
    return [...DSH_REASONING_LEVELS, ...legacy]
  }

  function isLegacyModelEffort(effort: string): boolean {
    return !(DSH_REASONING_LEVELS as readonly string[]).includes(effort)
  }

  function modelEffortSummary(draft: ModelEditorDraft): string {
    const count = modelEffortOptions(draft).length
    return count === 0 ? 'Provider controlled' : `${count} selected`
  }

  function handleModelReasoningEffortChange(key: number, effort: string, event: Event): void {
    const draft = modelDrafts.find((entry) => entry.key === key)
    const input = event.currentTarget
    if (draft === undefined || !(input instanceof HTMLInputElement)) return
    const updated = updateReasoningEffortSelection(
      draft.reasoningEfforts,
      effort,
      input.checked,
    )
    if (updated === undefined) {
      input.checked = false
      setSettingsStatus('Select at least one graded level before enabling Off.', 'warning')
      return
    }
    draft.reasoningEfforts = updated
  }

  function handleModelReasoningFormatChange(key: number, event: Event): void {
    const draft = modelDrafts.find((entry) => entry.key === key)
    const selected = (event as CustomEvent<{ value?: string }>).detail?.value
    const value = typeof selected === 'string' && selected.startsWith('format-') ? selected.slice('format-'.length) : selected
    if (draft === undefined || !isReasoningFormatOption(value)) return
    draft.reasoningFormat = value
    if (isBinaryReasoningFormat(value)) draft.binaryThinkingMode ??= 'on'
    void tick().then(initializeReasoningEffortPicker)
  }

  function handleBinaryThinkingModeChange(key: number, event: Event): void {
    const draft = modelDrafts.find((entry) => entry.key === key)
    const value = (event as CustomEvent<{ value?: string }>).detail?.value
    if (draft === undefined || (value !== 'on' && value !== 'off')) return
    draft.binaryThinkingMode = value
  }

  function isReasoningFormatOption(value: unknown): value is ReasoningFormat {
    return typeof value === 'string' && reasoningFormatOptions.includes(value as ReasoningFormat)
  }

  function parseChatTemplateDraft(value: string, label: string): Record<string, ChatTemplateValue> | undefined {
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

  function selectedModelEfforts(): string[] {
    return selectedEffortsForModel(model)
  }

  function selectedEffortsForModel(modelId: string): string[] {
    return selectableReasoningEfforts(models.find((entry) => entry.id === modelId))
  }

  function preferredEffortForModel(modelId: string): string | null {
    return preferredReasoningEffort(models.find((entry) => entry.id === modelId), reasoningHistory[modelId]) ?? null
  }

  function reasoningEffortLabel(): string {
    const selected = models.find((entry) => entry.id === model)
    if (selected !== undefined && isBinaryReasoningFormat(selected.reasoningFormat)) {
      return selected.binaryThinkingMode === 'off' ? 'Thinking Off' : 'Thinking On'
    }
    return reasoningEffort ?? 'Provider controlled'
  }

  function selectComposerReasoningEffort(value: string): void {
    if (selectedModelEfforts().includes(value)) reasoningEffort = value
  }

  function syncReasoningEffortWithCatalog(): void {
    const selected = models.find((entry) => entry.id === model)
    if (effortStateNeedsCatalog) {
      reasoningEffort = preferredEffortForModel(model)
      effortStateNeedsCatalog = false
    } else if (reasoningEffort !== null && !selected?.reasoningEfforts?.includes(reasoningEffort)) {
      reasoningEffort = preferredEffortForModel(model)
    } else if (reasoningEffort === null && selectedEffortsForModel(model).length > 0) {
      reasoningEffort = preferredEffortForModel(model)
    }
  }

  function saveModelCatalog(): void {
    modelCatalogSaving = true
    setSettingsStatus('Saving models…', 'warning')
    try {
      post({
        type: 'saveModelCatalog',
        models: modelDrafts.map((draft): ModelDraft => ({
          id: draft.id,
          displayName: draft.displayName,
          contextWindow: draft.contextWindow,
          acceptsImages: draft.acceptsImages ?? false,
          sourceId: draft.sourceId,
          reasoningEfforts: modelEffortOptions(draft),
          reasoningFormat: draft.reasoningFormat,
          binaryThinkingMode: draft.binaryThinkingMode,
          chatTemplateKwargs: parseChatTemplateDraft(draft.chatTemplateKwargsText, `Model "${draft.id}" chat template kwargs`),
          chatTemplateArgs: parseChatTemplateDraft(draft.chatTemplateArgsText, `Model "${draft.id}" chat template args`),
        })),
      })
    } catch (error) {
      modelCatalogSaving = false
      setSettingsStatus(error instanceof Error ? error.message : String(error), 'warning')
    }
  }

  function sandboxModeLabel(mode: SandboxMode = sandboxMode): string {
    if (mode === 'read-only') return 'Read-only'
    if (mode === 'danger-full-access') return 'Danger full access'
    return 'Workspace write'
  }

  function handleSandboxModeChange(event: Event): void {
    const detail = (event as CustomEvent<{ value?: string }>).detail
    const nextMode = detail?.value
    if (nextMode !== 'read-only' && nextMode !== 'workspace-write' && nextMode !== 'danger-full-access') return
    sandboxMode = nextMode
  }

  function appendMessage(role: ChatMessage['role'], label: string, text: string, context?: SelectionMetadata, browserLabels?: string[]): void {
    finishThinking()
    if (role !== 'user') waitingForFirstResponse = false
    messages = [...messages, { id: nextMessageId++, role, label, text, context, browserLabels }]
    void scrollToBottom()
  }

  function updateCompaction(entry: CompactionEntry): void {
    const existing = messages.find((message) => message.compaction?.key === entry.key)
    if (existing) {
      messages = messages.map((message) => message.id === existing.id ? { ...message, compaction: entry } : message)
    } else {
      messages = [...messages, { id: nextMessageId++, role: 'compaction', label: 'Context', text: '', compaction: entry }]
    }
    void scrollToBottom()
  }

  function interruptCompaction(sessionId?: string, error?: string): void {
    for (const entry of compactionHistory.interrupt(sessionId, error)) updateCompaction(entry)
  }

  function finishThinking(sessionId?: string): void {
    if (sessionId !== undefined && sessionId !== activeThinkingSessionId) return
    activeThinkingId = undefined
    activeThinkingSessionId = undefined
  }

  function appendStreamText(role: StreamUpdate['role'], text: string, sessionId?: string): void {
    if (!text) return
    if (role === 'assistant') finishThinking()
    waitingForFirstResponse = false
    const last = messages[messages.length - 1]
    if (last?.role === role) {
      messages = [...messages.slice(0, -1), { ...last, text: last.text + text }]
    } else {
      messages = [...messages, {
        id: nextMessageId++,
        role,
        label: role === 'reasoning' ? 'Thinking' : 'Helix',
        text,
      }]
    }
    if (role === 'reasoning' && sessionId !== undefined) {
      activeThinkingId = messages[messages.length - 1].id
      activeThinkingSessionId = sessionId
    }
    void scrollToBottom()
  }

  function isNearBottom(element: HTMLElement): boolean {
    return element.scrollHeight - element.clientHeight - element.scrollTop <= 24
  }

  function followThinkingStream(element: HTMLDivElement) {
    const details = element.parentElement as HTMLDetailsElement
    let following = true
    const scrollToLatest = () => {
      if (details.open && following) element.scrollTop = element.scrollHeight
    }
    const onScroll = () => { following = isNearBottom(element) }
    const observer = new MutationObserver(scrollToLatest)

    element.addEventListener('scroll', onScroll)
    details.addEventListener('toggle', scrollToLatest)
    observer.observe(element, { childList: true, characterData: true, subtree: true })

    return {
      destroy() {
        observer.disconnect()
        element.removeEventListener('scroll', onScroll)
        details.removeEventListener('toggle', scrollToLatest)
      },
    }
  }

  function handleTranscriptScroll(event: Event): void {
    followTranscript = isNearBottom(event.currentTarget as HTMLDivElement)
  }

  async function scrollToBottom(): Promise<void> {
    if (!followTranscript) return
    await tick()
    if (followTranscript && transcriptElement) transcriptElement.scrollTop = transcriptElement.scrollHeight
  }

  function numericValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  }

  function updateContextWindow(value: unknown): void {
    const selected = models.find((option) => option.id === model)
    if (selected?.contextWindow !== undefined) {
      contextWindowTokens = selected.contextWindow
      return
    }
    if (contextWindowOverride !== undefined) {
      contextWindowTokens = contextWindowOverride
      return
    }
    const next = numericValue(value)
    if (next !== undefined && next > 0) contextWindowTokens = next
  }

  function updateContextUsage(value: unknown): void {
    if (!isRecord(value)) return
    const inputTokens = numericValue(value.inputTokens)
    const outputTokens = numericValue(value.outputTokens)
    const cacheReadTokens = numericValue(value.cacheReadTokens)
    const cacheWriteTokens = numericValue(value.cacheWriteTokens)
    if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined) return

    contextUsedTokens = (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  }

  function contextProgress(): number {
    if (contextWindowTokens === undefined || contextUsedTokens === undefined) return 0
    return Math.min(100, Math.max(0, (contextUsedTokens / contextWindowTokens) * 100))
  }

  function formatTokenCount(value: number): string {
    return new Intl.NumberFormat().format(Math.round(value))
  }

  function changeKindSymbol(kind: CodeChange['kind']): string {
    if (kind === 'created') return 'A'
    if (kind === 'deleted') return 'D'
    if (kind === 'renamed') return 'R'
    return 'M'
  }

  function changeKindLabel(kind: CodeChange['kind']): string {
    if (kind === 'created') return 'created'
    if (kind === 'deleted') return 'deleted'
    if (kind === 'renamed') return 'renamed'
    return 'modified'
  }

  function changeSummaryLabel(): string {
    const fileLabel = `${codeChanges.length} ${codeChanges.length === 1 ? 'file' : 'files'}`
    const additions = codeChanges.reduce((total, change) => total + change.additions, 0)
    const deletions = codeChanges.reduce((total, change) => total + change.deletions, 0)
    if (additions === 0 && deletions === 0) return `${fileLabel} changed`
    return `${fileLabel} · +${additions} −${deletions}`
  }

  function mergeHostChanges(current: CodeChange[], incoming: CodeChange[]): CodeChange[] {
    const merged = new Map(current.map((change) => [change.path, change]))
    for (const change of incoming) {
      const existing = merged.get(change.path)
      if (existing === undefined) {
        merged.set(change.path, change)
        continue
      }
      merged.set(change.path, {
        ...existing,
        kind: mergeChangeKind(existing.kind, change.kind),
        additions: Math.max(existing.additions, change.additions),
        deletions: Math.max(existing.deletions, change.deletions),
        oldPath: change.oldPath ?? existing.oldPath,
      })
    }
    return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path))
  }

  function mergeChangeKind(existing: CodeChange['kind'], next: CodeChange['kind']): CodeChange['kind'] {
    if (next === 'renamed' || next === 'deleted') return next
    if (existing === 'created' || existing === 'renamed') return existing
    return next
  }

  function recordToolChange(change: CodeChange): void {
    const existing = codeChanges.find((current) => current.path === change.path)
    const alreadyDerived = toolDerivedPaths.has(change.path)
    const nextChange: CodeChange = existing === undefined
      ? change
      : {
          ...existing,
          kind: mergeChangeKind(existing.kind, change.kind),
          additions: alreadyDerived
            ? existing.additions + change.additions
            : Math.max(existing.additions, change.additions),
          deletions: alreadyDerived
            ? existing.deletions + change.deletions
            : Math.max(existing.deletions, change.deletions),
        }

    toolDerivedPaths.add(change.path)
    codeChanges = existing === undefined
      ? [...codeChanges, nextChange].sort((left, right) => left.path.localeCompare(right.path))
      : codeChanges.map((current) => current.path === change.path ? nextChange : current)
  }

  function contextMeterLabel(): string {
    if (contextWindowTokens === undefined) return 'Context window unavailable'
    if (contextUsedTokens === undefined) return `Context window: ${formatTokenCount(contextWindowTokens)} tokens`
    return `Context: ${formatTokenCount(contextUsedTokens)} of ${formatTokenCount(contextWindowTokens)} tokens (${Math.round(contextProgress())}%)`
  }

  function modelOptionLabel(option: SidebarModel): string {
    const name = option.displayName ?? option.id
    const context = option.contextWindow === undefined ? '' : ` · ${formatTokenCount(option.contextWindow)}`
    return `${name}${context}`
  }

  function selectedModelLabel(): string {
    const selected = models.find((option) => option.id === model)
    if (selected !== undefined) return modelOptionLabel(selected)
    if (model) return model
    return models.length === 0 ? 'No saved models' : 'Select model'
  }

  function composerModelEffortLabel(): string {
    return `Model: ${selectedModelLabel()}; Reasoning effort: ${reasoningEffortLabel()}`
  }

  function refreshModelCardPickers(): void {
    document.querySelectorAll<HTMLDivElement>('.model-card-select').forEach((picker) => {
      (picker as HTMLDivElement & { refresh?: () => void }).refresh?.()
    })
  }

  function initializeReasoningEffortPicker(): void {
    const basecoat = (window as Window & { basecoat?: { init?: (component: string) => void } }).basecoat
    basecoat?.init?.('select')
    basecoat?.init?.('popover')
    refreshModelCardPickers()
  }

  function refreshModelSourcePicker(): void {
    const picker = modelSourcePickerElement as (HTMLDivElement & { refresh?: () => void }) | undefined
    picker?.refresh?.()
  }

  function initializeSandboxPicker(): void {
    const basecoat = (window as Window & {
      basecoat?: {
        init?: (component: string) => void
      }
    }).basecoat
    basecoat?.init?.('select')
    basecoat?.init?.('popover')
    refreshSandboxPicker()
  }

  function initializeModelSourcePicker(): void {
    const basecoat = (window as Window & {
      basecoat?: {
        init?: (component: string) => void
      }
    }).basecoat
    basecoat?.init?.('combobox')
    refreshModelSourcePicker()
  }

  function refreshSandboxPicker(): void {
    const picker = sandboxPickerElement as (HTMLDivElement & { refresh?: () => void }) | undefined
    picker?.refresh?.()
  }

  function appendAssistantBlocks(content: unknown): void {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== 'string' || typeof block.text !== 'string') continue
      if (block.type === 'text') appendStreamText('assistant', block.text)
      if (block.type === 'reasoning') appendStreamText('reasoning', block.text)
    }
  }

  function handleAssistantStream(message: Extract<IncomingMessage, { type: 'assistantStream' }>): void {
    const frame = isRecord(message.frame) ? message.frame : undefined
    if (frame === undefined) return
    streamedStepTracker.recordLiveFrame(message.agentSessionId, frame)
    const update = liveToolCallTracker.recordFrame(message.agentSessionId, frame)
    removePreparingToolCalls(update.discard)
    if (update.prepared !== undefined) {
      const existing = messages.find((entry) => entry.tool?.callId === update.prepared?.callId)?.tool
      if (existing === undefined || existing.status === 'preparing') {
        upsertToolCall({
          callId: update.prepared.callId,
          name: update.prepared.name,
          arguments: '',
          status: 'preparing',
        })
      }
    }
    if (frame.type === 'start' || frame.type === 'end') {
      finishThinking(message.agentSessionId)
      return
    }
    if (frame.type !== 'chunk' || !isRecord(frame.chunk)) return
    const chunk = frame.chunk

    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') appendStreamText('assistant', chunk.text)
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') appendStreamText('reasoning', chunk.text, message.agentSessionId)
    if (chunk.type === 'tool-call-delta') finishThinking(message.agentSessionId)
    if (chunk.type === 'finish' || (chunk.type === 'block-end' && isRecord(chunk.block) && chunk.block.type === 'reasoning')) finishThinking(message.agentSessionId)
  }

  function upsertToolCall(tool: ToolCallView): void {
    finishThinking()
    waitingForFirstResponse = false
    const index = messages.findIndex((message) => message.tool?.callId === tool.callId)
    if (index === -1) {
      messages = [...messages, { id: nextMessageId++, role: 'tool', label: 'Tool', text: '', tool }]
    } else {
      const next = [...messages]
      const existing = next[index].tool
      if (!existing) return
      next[index] = { ...next[index], tool: { ...existing, ...tool } }
      messages = next
    }
    void scrollToBottom()
  }

  function handleQuestionRequest(request: PendingUserQuestion): void {
    if (messages.some((message) => message.tool?.question?.requestId === request.requestId)) return
    isGenerating = true
    upsertToolCall({ callId: request.toolCallId, name: 'ask_user_question', arguments: '', status: 'running',
      question: { ...request, status: 'pending' } })
  }

  function updateQuestion(requestId: string, update: Partial<UserQuestionView>): void {
    messages = messages.map((message) => message.tool?.question?.requestId === requestId
      ? { ...message, tool: { ...message.tool, question: { ...message.tool.question, ...update } } } : message)
  }

  function endPendingQuestions(): void {
    for (const message of messages) {
      const question = message.tool?.question
      if (question?.status === 'pending' || question?.status === 'submitting') updateQuestion(question.requestId, { status: 'cancelled' })
    }
  }

  function answerQuestion(question: UserQuestionView, value: UserQuestionAnswer): void {
    if (question.status !== 'pending') return
    try {
      const answer = validateQuestionAnswer(question.question, value)
      updateQuestion(question.requestId, { status: 'submitting', error: undefined })
      post({ type: 'questionAnswer', sessionId: activeSessionId, requestId: question.requestId, answer })
    } catch (error) { updateQuestion(question.requestId, { error: error instanceof Error ? error.message : String(error) }) }
  }

  function removePreparingToolCalls(callIds: string[]): void {
    if (callIds.length === 0) return
    const discarded = new Set(callIds)
    messages = messages.filter((entry) => entry.tool?.status !== 'preparing' || !discarded.has(entry.tool.callId))
  }

  function handleApprovalRequest(message: Extract<IncomingMessage, { type: 'approvalRequest' }>): void {
    const approval: ApprovalView = {
      requestId: message.requestId,
      reason: message.reason,
      status: 'pending',
    }
    pendingApprovalRequests[message.requestId] = { ...message, approval }
    const callId = message.toolCallId ?? `approval-${message.requestId}`
    const index = messages.findIndex((entry) => entry.tool?.callId === callId)
    if (index === -1) {
      upsertToolCall({
        callId,
        name: message.toolName,
        arguments: '',
        status: 'running',
        approval,
      })
      return
    }

    const next = [...messages]
    const tool = next[index].tool
    if (!tool) return
    next[index] = { ...next[index], tool: { ...tool, approval } }
    messages = next
    void scrollToBottom()
  }

  function updateToolApproval(
    requestId: string,
    status: ApprovalView['status'],
  ): void {
    const index = messages.findIndex((entry) => entry.tool?.approval?.requestId === requestId)
    if (index === -1) return
    const next = [...messages]
    const tool = next[index].tool
    if (!tool?.approval) return
    next[index] = {
      ...next[index],
      tool: { ...tool, approval: { ...tool.approval, status, decisionPending: false } },
    }
    messages = next
    void scrollToBottom()
  }

  function decideApproval(tool: ToolCallView, outcome: 'allowed-once' | 'rejected'): void {
    if (tool.approval?.status !== 'pending' || tool.approval.decisionPending) return
    const index = messages.findIndex((entry) => entry.tool?.callId === tool.callId)
    if (index === -1) return
    const next = [...messages]
    const current = next[index].tool
    if (!current?.approval) return
    const requestId = current.approval.requestId
    next[index] = {
      ...next[index],
      tool: { ...current, approval: { ...current.approval, decisionPending: true } },
    }
    messages = next
    post({ type: 'approvalDecision', sessionId: activeSessionId, requestId, outcome })
  }

  function updateToolResult(callId: string, result: string, error?: string, meta?: string): void {
    const index = messages.findIndex((message) => message.tool?.callId === callId)
    if (index === -1) {
      upsertToolCall({
        callId,
        name: 'Tool result',
        arguments: '',
        result,
        meta,
        error,
        status: error ? 'error' : 'completed',
      })
      return
    }

    const next = [...messages]
    const existing = next[index].tool
    if (!existing) return
    next[index] = {
      ...next[index],
      tool: {
        ...existing,
        result,
        meta,
        error,
        status: error ? 'error' : 'completed',
      },
    }
    messages = next
    void scrollToBottom()
  }

  function toolStepKey(sessionId: string | undefined, data: Record<string, unknown>): string | undefined {
    const response = responseKey(data)
    if (!response) return undefined
    return `${sessionId ?? activeSessionId}:${response}`
  }

  function toolResultCallId(
    data: Record<string, unknown>,
    message: Record<string, unknown>,
    sessionId: string | undefined,
  ): string {
    const direct = stringValue(data.callId)
    if (direct) return direct

    const source = isRecord(message.source) ? message.source : undefined
    const sourceCallId = source ? stringValue(source.callId) : undefined
    if (sourceCallId) return sourceCallId

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block)) continue
        const blockCallId = stringValue(block.toolCallId)
        if (blockCallId) return blockCallId
      }
    }

    const stepKey = toolStepKey(sessionId, data)
    if (stepKey !== undefined && toolCallsByStep[stepKey] !== undefined) {
      return toolCallsByStep[stepKey]
    }

    return responseKey(data) || `tool-result-${nextMessageId}`
  }

  function pendingToolKey(
    data: Record<string, unknown>,
    message: Record<string, unknown>,
    sessionId: string | undefined,
  ): string | undefined {
    const direct = stringValue(data.callId)
    if (direct) return direct

    const source = isRecord(message.source) ? message.source : undefined
    const sourceCallId = source ? stringValue(source.callId) : undefined
    if (sourceCallId) return sourceCallId

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block)) continue
        const blockCallId = stringValue(block.toolCallId)
        if (blockCallId) return blockCallId
      }
    }

    return toolStepKey(sessionId, data)
  }

  function toolResultText(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(toolResultText).filter(Boolean).join('\n\n')
    if (!isRecord(value)) return ''
    if (typeof value.text === 'string') return value.text
    if (Array.isArray(value.content)) return toolResultText(value.content)
    if ('value' in value) return stringifyPayload(value.value)
    return ''
  }

  function toolResultIsError(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(toolResultIsError)
    if (!isRecord(value)) return false
    return value.isError === true || (Array.isArray(value.content) && toolResultIsError(value.content))
  }

  function formatToolArguments(value: string): string {
    if (!value) return 'No arguments'
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }

  function stringifyPayload(value: unknown): string {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value, null, 2) ?? ''
    } catch {
      return String(value)
    }
  }

  function toolStatusLabel(tool: ToolCallView): string {
    if (tool.approval?.status === 'pending') return tool.approval.decisionPending ? 'sending' : 'approval'
    if (tool.approval?.status === 'allowed-once') return 'allowed once'
    if (tool.approval?.status === 'rejected') return 'denied'
    if (tool.approval?.status === 'cancelled') return 'cancelled'
    if (tool.approval?.status === 'unavailable') return 'unavailable'
    if (tool.status === 'preparing') return 'preparing'
    if (tool.status === 'running') return 'running'
    if (tool.status === 'error') return 'failed'
    return 'completed'
  }

  function approvalResultLabel(status: ApprovalView['status']): string {
    if (status === 'allowed-once') return 'Allowed once'
    if (status === 'rejected') return 'Denied'
    if (status === 'cancelled') return 'Cancelled'
    if (status === 'unavailable') return 'Unavailable'
    return 'Approval required'
  }

  function handleNotification(value: unknown): void {
    if (!isRecord(value)) return
    const notification = value as HarnessNotification
    const params = isRecord(notification.params) ? notification.params : {}

    if (notification.method === 'session.status') {
      const statusSessionId = stringValue(params.sessionId)
      if (statusSessionId !== activeSessionId) {
        if (statusSessionId !== undefined && params.status !== 'running') {
          interruptCompaction(statusSessionId)
          removePreparingToolCalls(liveToolCallTracker.clear(statusSessionId))
        }
        return
      }
      if (params.status === 'running') {
        isGenerating = true
      } else {
        interruptCompaction(activeSessionId)
        removePreparingToolCalls(liveToolCallTracker.clear())
        finishThinking()
        isGenerating = false
        waitingForFirstResponse = false
        if (codeChanges.length > 0) {
          void scrollToBottom()
        }
      }
      return
    }

    if (notification.method === 'subagent.started') {
      waitingForFirstResponse = false
      appendMessage('activity', 'Subagent', `Started ${String(params.childSessionId || 'child session')}`)
      return
    }

    if (notification.method === 'subagent.finished') {
      const childSessionId = stringValue(params.childSessionId)
      if (childSessionId !== undefined) interruptCompaction(childSessionId)
      if (childSessionId !== undefined) removePreparingToolCalls(liveToolCallTracker.clear(childSessionId))
      appendMessage('activity', 'Subagent', `Finished ${String(params.childSessionId || 'child session')}`)
      return
    }

    if (notification.method !== 'session.event' || !isRecord(params.event)) return
    const event = params.event as HarnessEvent
    const data = isRecord(event.data) ? event.data : {}
    const isRootSessionEvent = params.sessionId === activeSessionId
    const sessionId = stringValue(params.sessionId)

    if (sessionId !== undefined && event.type !== undefined) {
      const compaction = compactionHistory.record(sessionId, event.type, data)
      if (compaction) {
        if (isRootSessionEvent) contextUsedTokens = undefined
        waitingForFirstResponse = false
        finishThinking(sessionId)
        updateCompaction(compaction)
        return
      }
      if (event.type === 'turn/end') interruptCompaction(sessionId)
    }

    if (event.type === 'request/context') {
      if (isRootSessionEvent) updateContextWindow(data.contextWindow)
      return
    }

    if (event.type === 'assistant/chunk') {
      const chunk = isRecord(data.chunk) ? data.chunk : undefined
      streamedStepTracker.recordDurableChunk(sessionId, data)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') appendStreamText('assistant', chunk.text)
      if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') appendStreamText('reasoning', chunk.text, sessionId ?? activeSessionId)
      if (chunk?.type === 'tool-call-delta') finishThinking(sessionId)
      if (chunk?.type === 'finish' || (chunk?.type === 'block-end' && isRecord(chunk.block) && chunk.block.type === 'reasoning')) finishThinking(sessionId)
      if (isRootSessionEvent && chunk?.type === 'usage') updateContextUsage(chunk.usage)
      return
    }

    if (event.type === 'assistant/message') {
      finishThinking(sessionId)
      if (sessionId !== undefined) removePreparingToolCalls(liveToolCallTracker.reconcileMessage(sessionId, data))
      if (isRootSessionEvent) updateContextUsage(data.usage)
      if (!streamedStepTracker.hasStreamedStep(sessionId, data)) {
        const message = isRecord(data.message) ? data.message : {}
        appendAssistantBlocks(message.content)
      }
      return
    }

    if (event.type === 'assistant/attempt') {
      finishThinking(sessionId)
      if (sessionId !== undefined) removePreparingToolCalls(liveToolCallTracker.clearStep(sessionId, data))
      return
    }

    if (event.type === 'tool/call') {
      const callId = stringValue(data.callId) ?? (responseKey(data) || `tool-call-${nextMessageId}`)
      if (sessionId !== undefined) liveToolCallTracker.finishCall(sessionId, callId)
      const stepKey = toolStepKey(sessionId, data)
      if (stepKey !== undefined) toolCallsByStep[stepKey] = callId
      const toolName = stringValue(data.name)
      const toolArguments = parsePayload(data.arguments)
      const plannedChange = toolName === undefined || toolArguments === undefined
        ? undefined
        : toolChange(toolName, toolArguments)
      const pendingKey = stringValue(data.callId) ?? stepKey
      if (plannedChange !== undefined && pendingKey !== undefined) {
        pendingCodeChanges[pendingKey] = plannedChange
      }
      const approval = Object.values(pendingApprovalRequests).find((entry) => entry.toolCallId === callId)?.approval
      upsertToolCall({
        callId,
        name: toolName ?? 'Tool call',
        arguments: typeof data.arguments === 'string' ? data.arguments : stringifyPayload(data.arguments),
        status: 'running',
        ...(approval === undefined ? {} : { approval }),
      })
      return
    }

    if (event.type === 'tool/result') {
      const resultMessage = isRecord(data.message) ? data.message : {}
      const resultContent = resultMessage.content
      const error = isRecord(data.error)
        ? [stringValue(data.error.name), stringValue(data.error.code)].filter(Boolean).join(': ')
        : toolResultIsError(resultContent) ? 'Tool reported an error.' : undefined
      const meta = data.meta === undefined ? undefined : stringifyPayload(data.meta)
      const callId = toolResultCallId(data, resultMessage, sessionId)
      if (sessionId !== undefined) liveToolCallTracker.finishCall(sessionId, callId)
      const pendingKey = pendingToolKey(data, resultMessage, sessionId)
      const plannedChange = pendingKey === undefined ? undefined : pendingCodeChanges[pendingKey]
      if (pendingKey !== undefined) delete pendingCodeChanges[pendingKey]
      if (plannedChange !== undefined && !error) {
        recordToolChange({
          ...plannedChange,
          kind: plannedChange.kind === 'modified' && /created file/i.test(toolResultText(resultContent))
            ? 'created'
            : plannedChange.kind,
        })
      }
      updateToolResult(callId, toolResultText(resultContent), error || undefined, meta)
    }
  }

  function openSettings(page: SettingsPage): void {
    if (settingsPage !== undefined && settingsPage !== page) resetSettingsPageDrafts(settingsPage)
    settingsPage = page
    setSettingsStatus('', '')
    post({ type: 'openSettings' })
    if (page === 'models') {
      modelsLoading = true
      modelsError = ''
      modelCatalogLoading = true
      modelCatalogError = ''
      discoveredModels = []
      post({ type: 'loadModelCatalog' })
      post({ type: 'refreshModels' })
    }
    void tick().then(() => {
      if (page === 'models') initializeModelSourcePicker()
      if (page === 'connection') initializeSandboxPicker()
    })
  }

  function settingsPageTitle(page: SettingsPage): string {
    switch (page) {
      case 'connection': return 'Connection Settings'
      case 'models': return 'Models'
      case 'mcp': return 'MCP Servers'
      case 'preview': return 'Request Previewer'
      case 'about': return 'About Helix'
    }
  }

  function resetSettingsPageDrafts(page: SettingsPage): void {
    if (page === 'connection' && settings !== undefined) {
      provider = settings.provider
      baseUrl = settings.baseUrl
      sandboxMode = settings.sandboxMode
      apiKey = ''
      clearApiKey = false
      decisions = { ...DEFAULT_DECISION_SETTINGS, ...settings.decisions }
      decisionsApiKey = ''
      clearDecisionsApiKey = false
    } else if (page === 'models') {
      modelDrafts = models.map(toModelEditorDraft)
    } else if (page === 'mcp' && settings !== undefined) {
      mcpServers = settings.mcpServers.map(toMcpServerDraft)
    }
  }

  function closeSettings(): void {
    if (settingsPage !== undefined) resetSettingsPageDrafts(settingsPage)
    settingsPage = undefined
    setSettingsStatus('', '')
  }

  function submitRequestPreview(): void {
    const text = requestPreviewPrompt.trim()
    if (!text || requestPreviewState === 'loading') return
    requestPreviewState = 'loading'
    requestPreview = undefined
    requestPreviewError = ''
    post({ type: 'previewRequest', prompt: text })
  }

  function cancelRequestPreview(): void {
    if (requestPreviewState !== 'loading') return
    post({ type: 'cancelRequestPreview' })
  }

  function saveSettings(): void {
    settingsRestarting = true
    setSettingsStatus('Applying settings…', 'warning')
    post({
      type: 'saveSettings',
      provider,
      baseUrl,
      apiKey,
      clearApiKey,
      ...(skillPickerEnabled ? { decisions: { ...decisions }, decisionsApiKey, clearDecisionsApiKey } : {}),
      sandboxMode,
    })
  }

  function saveMcpServers(): void {
    mcpSaving = true
    settingsRestarting = true
    setSettingsStatus('Applying MCP server settings…', 'warning')
    post({ type: 'saveMcpServers', mcpServers: mcpServers.map(toMcpServerMessage) })
  }

  function toMcpServerMessage(server: McpServerDraft): SidebarMcpServer {
    return {
      serverName: server.serverName,
      transport: server.transport,
      command: server.command,
      args: server.argsText.split(/\r?\n/).map((argument) => argument.trim()).filter(Boolean),
      url: server.url,
      env: server.env.map(({ name, value, configured }): SidebarMcpEnvironment => ({ name, value, configured })),
    }
  }

  function addMcpServer(): void {
    mcpServers = [{
      serverName: '',
      transport: 'stdio',
      command: '',
      argsText: '',
      url: '',
      env: [],
    }, ...mcpServers]
  }

  function removeMcpServer(index: number): void {
    mcpServers = mcpServers.filter((_, currentIndex) => currentIndex !== index)
  }

  function addMcpEnvironment(index: number): void {
    mcpServers[index].env = [...mcpServers[index].env, { name: '', value: '', configured: false }]
  }

  function removeMcpEnvironment(serverIndex: number, environmentIndex: number): void {
    mcpServers[serverIndex].env = mcpServers[serverIndex].env.filter((_, index) => index !== environmentIndex)
  }

  function clearStoredKey(): void {
    clearApiKey = true
    apiKey = ''
    setSettingsStatus('Save settings to remove the stored key.', 'warning')
  }

  function toolChange(name: string, argumentsValue: Record<string, unknown>): CodeChange | undefined {
    const normalizedName = name.toLowerCase()
    const filePath = stringValue(argumentsValue.file_path) ?? stringValue(argumentsValue.filePath) ?? stringValue(argumentsValue.path)
    if (filePath === undefined) return undefined

    if (normalizedName === 'write' || /(?:^|[/_.])write$/.test(normalizedName) || /(?:^|__)write$/.test(normalizedName)) {
      const content = textValue(argumentsValue.content)
      if (content === undefined) return undefined
      return { path: filePath, kind: 'modified', additions: countLines(content), deletions: 0 }
    }

    if (normalizedName === 'edit' || /(?:^|[/_.])edit$/.test(normalizedName) || /(?:^|__)edit$/.test(normalizedName)) {
      const oldString = stringValue(argumentsValue.old_string) ?? stringValue(argumentsValue.oldString)
      const newString = textValue(argumentsValue.new_string) ?? textValue(argumentsValue.newString)
      if (oldString === undefined || newString === undefined) return undefined
      return { path: filePath, kind: 'modified', additions: countLines(newString), deletions: countLines(oldString) }
    }

    if (!normalizedName.includes('str_replace_editor')) return undefined
    const command = stringValue(argumentsValue.command)
    if (command === 'create') {
      const fileText = textValue(argumentsValue.file_text) ?? textValue(argumentsValue.fileText) ?? ''
      return { path: filePath, kind: 'created', additions: countLines(fileText), deletions: 0 }
    }
    if (command === 'str_replace') {
      const oldString = stringValue(argumentsValue.old_str) ?? stringValue(argumentsValue.oldStr)
      const newString = textValue(argumentsValue.new_str) ?? textValue(argumentsValue.newStr) ?? ''
      if (oldString === undefined) return undefined
      return { path: filePath, kind: 'modified', additions: countLines(newString), deletions: countLines(oldString) }
    }
    if (command === 'insert') {
      const newString = textValue(argumentsValue.new_str) ?? textValue(argumentsValue.newStr) ?? ''
      return { path: filePath, kind: 'modified', additions: countLines(newString), deletions: 0 }
    }
    return undefined
  }

  function textValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
  }
</script>

{#snippet changeRows()}
  {#each codeChanges as change (change.path)}
    <div class="change-row">
      <span class={`change-kind ${change.kind}`} title={changeKindLabel(change.kind)}>{changeKindSymbol(change.kind)}</span>
      <div class="change-file">
        <span class="change-path" title={change.path}>{change.path}</span>
        {#if change.oldPath}<small>from {change.oldPath}</small>{/if}
      </div>
      <span class="change-stats">
        {#if change.additions > 0}<span class="change-additions">+{change.additions}</span>{/if}
        {#if change.deletions > 0}<span class="change-deletions">−{change.deletions}</span>{/if}
        {#if change.additions === 0 && change.deletions === 0}<span>{changeKindLabel(change.kind)}</span>{/if}
      </span>
    </div>
  {/each}
{/snippet}

<main class="shell">
  <Masthead
    onNewSession={startNewSession}
    onOpenSettings={openSettings}
  />

  {#if settingsPage}
    <section class="settings-view" aria-labelledby="settings-heading">
      <div class="settings-heading">
        <button class="btn icon-button" data-variant="ghost" data-size="icon" type="button" aria-label="Back to chat" title="Back to chat" onclick={closeSettings}>
          <ArrowLeft size={15} strokeWidth={1.8} />
        </button>
        <div>
          <h2 id="settings-heading">{settingsPageTitle(settingsPage)}</h2>
        </div>
      </div>

      {#if settingsPage === 'about'}
        <AboutSettings info={extensionInfo} />
      {:else if settingsPage === 'connection'}
      <form class="settings-form" onsubmit={(event) => { event.preventDefault(); saveSettings() }}>
        <div class="field" role="group">
          <label for="provider">Provider route</label>
          <input id="provider" class="input" type="text" bind:value={provider} placeholder="deepseek-official" />
        </div>

        {#if provider.trim() === 'deepseek-official'}
          <p class="route-warning" role="status">The direct <code>deepseek-official</code> route uses DSH’s fixed adapter. Model reasoning formats here require an existing <code>llm-pi-ai</code> route; this route will not apply the format settings.</p>
        {/if}

        <div class="field" role="group">
          <label for="base-url">API base URL</label>
          <input id="base-url" class="input" type="url" bind:value={baseUrl} placeholder="https://api.deepseek.com" />
          <small>Leave empty to use the provider default.</small>
        </div>

        <div class="field" role="group">
          <label for="api-key">API key</label>
          <div class="api-key-input-row">
            <input id="api-key" class="input" type="password" bind:value={apiKey} oninput={() => { if (apiKey) clearApiKey = false }} placeholder={settings?.apiKeyConfigured ? 'Saved key — enter a new key to replace it' : 'Paste an API key'} autocomplete="off" />
            <button class="btn icon-button clear-key" data-variant="ghost" data-size="icon" type="button" aria-label="Clear API key" title="Clear API key" onclick={clearStoredKey} disabled={!settings?.apiKeyConfigured && !apiKey}>
              <Trash2 size={13} strokeWidth={1.8} />
            </button>
          </div>
          <small class="key-status">
            {#if clearApiKey}<Trash2 size={11} strokeWidth={1.8} /> The saved key will be removed when you save.
            {:else if settings?.apiKeyConfigured}<Check size={11} strokeWidth={1.8} /> A key is currently saved.
            {:else}No key saved yet.{/if}
          </small>
        </div>

        {#if skillPickerEnabled}<DecisionSettingsPanel bind:decisions bind:apiKey={decisionsApiKey} bind:clearKey={clearDecisionsApiKey} mainUrl={baseUrl} {provider} keyConfigured={settings?.decisions?.apiKeyConfigured ?? false} />{/if}

        <div class="field" role="group">
          <label for="sandbox-picker-trigger">Sandbox permissions</label>
          <div
            id="sandbox-picker"
            class="select sandbox-settings-picker"
            bind:this={sandboxPickerElement}
            data-placeholder="Sandbox permissions"
            onchange={handleSandboxModeChange}
          >
            <button
              id="sandbox-picker-trigger"
              class="btn"
              data-variant="outline"
              type="button"
              aria-haspopup="listbox"
              aria-expanded="false"
              aria-controls="sandbox-picker-listbox"
            >
              <span>{sandboxModeLabel()}</span>
              <ChevronDown size={13} strokeWidth={1.7} />
            </button>
            <div id="sandbox-picker-popover" data-popover data-side="bottom" data-align="start" aria-hidden="true">
              <div
                id="sandbox-picker-listbox"
                class="sandbox-picker-listbox"
                role="listbox"
                aria-orientation="vertical"
                aria-labelledby="sandbox-picker-trigger"
              >
                <div role="option" data-value="read-only" aria-selected={sandboxMode === 'read-only' ? 'true' : undefined}><span>Read-only</span></div>
                <div role="option" data-value="workspace-write" aria-selected={sandboxMode === 'workspace-write' ? 'true' : undefined}><span>Workspace write</span></div>
                <div role="option" data-value="danger-full-access" aria-selected={sandboxMode === 'danger-full-access' ? 'true' : undefined}><span>Danger full access</span></div>
              </div>
            </div>
            <input type="hidden" name="sandbox-mode" value={sandboxMode} />
          </div>
        </div>

        <div class="settings-footer">
          <button class="btn save-settings" type="submit" disabled={settingsRestarting}>
            {#if settingsRestarting}<LoaderCircle class="spin" size={13} strokeWidth={1.8} /> Applying…{:else}Save connection settings <Check size={13} strokeWidth={1.8} />{/if}
          </button>
        </div>
      </form>
      {:else if settingsPage === 'models'}
        <div class="settings-form">
        <section class="model-settings" aria-labelledby="model-settings-title">
          <div class="model-settings-heading">
            <h3 id="model-settings-title">Models</h3>
          </div>

          {#if modelsError}<p class="model-error" role="status">{modelsError}</p>{/if}
          {#if modelCatalogError}<p class="model-error" role="alert">{modelCatalogError} Model edits are disabled to protect the saved file.</p>{/if}

          <div class="model-source-row">
            <div
              id="model-source-picker"
              class="combobox model-source-picker"
              bind:this={modelSourcePickerElement}
              onchange={handleAddDiscoveredModel}
            >
              <input
                type="text"
                class="input"
                role="combobox"
                placeholder={modelsLoading ? 'Loading endpoint models…' : 'Search fetched models to add'}
                autocomplete="off"
                autocorrect="off"
                spellcheck="false"
                aria-autocomplete="list"
                aria-expanded="false"
                aria-controls="model-source-listbox"
                aria-label="Add a fetched model"
                disabled={modelsLoading || modelCatalogLoading || modelCatalogError !== ''}
              />
              <ChevronDown class="combobox-trigger-icon" size={14} strokeWidth={1.7} aria-hidden="true" />
              <div id="model-source-popover" data-popover aria-hidden="true">
                <div
                  id="model-source-listbox"
                  role="listbox"
                  aria-orientation="vertical"
                  data-empty={modelsLoading ? 'Loading endpoint models…' : modelsError || 'No endpoint models found.'}
                >
                  {#each discoveredModels as option (option.id)}
                    <div
                      role="option"
                      data-value={option.id}
                      data-filter={`${option.displayName ?? ''} ${option.id}`}
                      aria-selected="false"
                      aria-disabled={modelDrafts.some((draft) => draft.id === option.id) ? 'true' : undefined}
                    >
                      {modelOptionLabel(option)}
                    </div>
                  {/each}
                </div>
              </div>
              <input type="hidden" name="discovered-model" value="" />
            </div>
            <button class="btn model-source-refresh" data-variant="outline" type="button" onclick={refreshModels} disabled={modelsLoading || modelCatalogLoading || modelCatalogError !== ''}>
              {#if modelsLoading}<LoaderCircle class="spin" size={13} strokeWidth={1.8} />{:else}<RefreshCw size={13} strokeWidth={1.8} />{/if}
              Refresh list
            </button>
          </div>

          {#if modelCatalogLoading}
            <div class="mcp-empty"><LoaderCircle class="spin" size={14} strokeWidth={1.8} /> Loading saved models…</div>
          {:else if modelDrafts.length === 0}
            <div class="mcp-empty"><Server size={14} strokeWidth={1.7} /> No saved models yet. Add one from the fetched list above.</div>
          {:else}
            <div class="model-list">
              {#each modelDrafts as draft (draft.key)}
                <fieldset class="model-card">
                  <legend>
                    <span>{draft.displayName || draft.id || 'New model'}</span>
                    <button class="btn icon-button mcp-remove" data-variant="ghost" data-size="icon" type="button" aria-label={`Remove ${draft.displayName || draft.id || 'model'}`} title="Remove model" onclick={() => removeModelDraft(draft.key)} disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''}>
                      <Trash2 size={13} strokeWidth={1.8} />
                    </button>
                  </legend>
                  <div class="model-card-fields">
                    <div class="field" role="group">
                      <label for={`model-id-${draft.key}`}>Model ID</label>
                      <input id={`model-id-${draft.key}`} class="input" bind:value={draft.id} autocomplete="off" disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''} />
                    </div>
                    <div class="field" role="group">
                      <label for={`model-label-${draft.key}`}>Display name</label>
                      <input id={`model-label-${draft.key}`} class="input" bind:value={draft.displayName} placeholder="Optional" autocomplete="off" disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''} />
                    </div>
                    <div class="field" role="group">
                      <label for={`model-context-${draft.key}`}>Context window</label>
                      <input id={`model-context-${draft.key}`} class="input" type="number" min="1" step="1" bind:value={draft.contextWindow} placeholder="Unknown" disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''} />
                    </div>
                    <div class="field model-vision-field">
                      <div class="model-vision-control">
                        <label for={`model-vision-${draft.key}`}>Vision</label>
                        <input id={`model-vision-${draft.key}`} class="input" type="checkbox" role="switch" data-size="sm" bind:checked={draft.acceptsImages} aria-describedby={`model-vision-help-${draft.key}`} disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''} />
                      </div>
                      <small id={`model-vision-help-${draft.key}`}>Allow image input if the endpoint supports it.</small>
                    </div>
                    <div class="field model-reasoning-format-field" role="group">
                      <label for={`model-reasoning-format-trigger-${draft.key}`}>Reasoning format</label>
                      <div
                        id={`model-reasoning-format-${draft.key}`}
                        class="select model-card-select"
                        data-placeholder="Auto / DSH default"
                        onchange={(event) => handleModelReasoningFormatChange(draft.key, event)}
                      >
                        <button
                          id={`model-reasoning-format-trigger-${draft.key}`}
                          class="btn"
                          data-variant="outline"
                          type="button"
                          aria-haspopup="listbox"
                          aria-expanded="false"
                          aria-controls={`model-reasoning-format-listbox-${draft.key}`}
                          disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''}
                        >
                          <span>{draft.reasoningFormat === 'auto' || draft.reasoningFormat === undefined ? 'Auto / DSH default' : draft.reasoningFormat}</span>
                          <ChevronDown size={13} strokeWidth={1.7} />
                        </button>
                        <div data-popover aria-hidden="true" data-side="bottom" data-align="start">
                          <div id={`model-reasoning-format-listbox-${draft.key}`} role="listbox" aria-orientation="vertical" aria-labelledby={`model-reasoning-format-trigger-${draft.key}`}>
                            {#each reasoningFormatOptions as format (`${draft.key}-${format}`)}
                              <div role="option" data-value={`format-${format}`} aria-selected={(draft.reasoningFormat ?? 'auto') === format ? 'true' : undefined}>{format === 'auto' ? 'Auto / DSH default' : format}</div>
                            {/each}
                          </div>
                        </div>
                        <input type="hidden" name={`model-reasoning-format-${draft.key}`} value={`format-${draft.reasoningFormat ?? 'auto'}`} />
                      </div>
                    </div>
                    {#if isBinaryReasoningFormat(draft.reasoningFormat)}
                      <div class="field" role="group">
                        <label for={`model-binary-thinking-trigger-${draft.key}`}>Thinking mode</label>
                        <div
                          id={`model-binary-thinking-${draft.key}`}
                          class="select model-card-select"
                          data-placeholder="On"
                          onchange={(event) => handleBinaryThinkingModeChange(draft.key, event)}
                        >
                          <button id={`model-binary-thinking-trigger-${draft.key}`} class="btn" data-variant="outline" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls={`model-binary-thinking-listbox-${draft.key}`} disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''}>
                            <span>{draft.binaryThinkingMode === 'off' ? 'Off' : 'On'}</span>
                            <ChevronDown size={13} strokeWidth={1.7} />
                          </button>
                          <div data-popover aria-hidden="true" data-side="bottom" data-align="start">
                            <div id={`model-binary-thinking-listbox-${draft.key}`} role="listbox" aria-orientation="vertical" aria-labelledby={`model-binary-thinking-trigger-${draft.key}`}>
                              <div role="option" data-value="on" aria-selected={draft.binaryThinkingMode === 'on' ? 'true' : undefined}>On</div>
                              <div role="option" data-value="off" aria-selected={draft.binaryThinkingMode === 'off' ? 'true' : undefined}>Off</div>
                            </div>
                          </div>
                          <input type="hidden" name={`model-binary-thinking-${draft.key}`} value={draft.binaryThinkingMode ?? 'on'} />
                        </div>
                        <small>This format has a binary control, so the composer has no effort selector.</small>
                      </div>
                    {:else}
                      <div class="field model-reasoning-level-field" role="group">
                        <label id={`model-reasoning-level-label-${draft.key}`} for={`model-reasoning-level-trigger-${draft.key}`}>Reasoning levels</label>
                        <div
                          id={`model-reasoning-level-picker-${draft.key}`}
                          class="popover model-reasoning-level-picker"
                        >
                          <button id={`model-reasoning-level-trigger-${draft.key}`} class="btn" data-variant="outline" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls={`model-reasoning-level-popover-${draft.key}`} disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''}>
                            <span>{modelEffortSummary(draft)}</span>
                            <ChevronDown size={13} strokeWidth={1.7} />
                          </button>
                          <div id={`model-reasoning-level-popover-${draft.key}`} data-popover aria-hidden="true" data-side="bottom" data-align="start" role="dialog" aria-labelledby={`model-reasoning-level-label-${draft.key}`}>
                            <fieldset class="model-reasoning-level-options">
                              <legend>Choose supported levels</legend>
                              {#each modelReasoningEffortChoices(draft) as effort, index (`${draft.key}-${effort}`)}
                                <div class="field model-reasoning-level-option" data-orientation="horizontal">
                                  <input id={`model-reasoning-level-${draft.key}-${index}`} class="input" type="checkbox" checked={draft.reasoningEfforts.includes(effort)} onchange={(event) => handleModelReasoningEffortChange(draft.key, effort, event)} disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''} />
                                  <label for={`model-reasoning-level-${draft.key}-${index}`}>{effort}{#if isLegacyModelEffort(effort)} <span>(saved ID)</span>{/if}</label>
                                </div>
                              {/each}
                            </fieldset>
                          </div>
                        </div>
                      </div>
                    {/if}
                    {#if draft.reasoningFormat === 'chat-template'}
                      <div class="field template-settings-field" role="group">
                        <label for={`model-chat-template-kwargs-${draft.key}`}>chatTemplateKwargs (JSON)</label>
                        <textarea id={`model-chat-template-kwargs-${draft.key}`} class="textarea model-template-input" rows="4" bind:value={draft.chatTemplateKwargsText} placeholder={'{\n  "enable_thinking": { "$var": "thinking.enabled", "omitWhenOff": true }\n}'} disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''}></textarea>
                        <small>Values may be strings, numbers, booleans, null, or DSH variables: thinking.enabled, thinking.effort, thinking.budget.</small>
                      </div>
                    {/if}
                    {#if draft.reasoningFormat === 'baseten'}
                      <div class="field template-settings-field" role="group">
                        <label for={`model-chat-template-args-${draft.key}`}>chatTemplateArgs (JSON)</label>
                        <textarea id={`model-chat-template-args-${draft.key}`} class="textarea model-template-input" rows="4" bind:value={draft.chatTemplateArgsText} placeholder={'{\n  "reasoning_effort": { "$var": "thinking.effort" }\n}'} disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''}></textarea>
                        <small>Values may be strings, numbers, booleans, null, or DSH variables: thinking.enabled, thinking.effort, thinking.budget.</small>
                      </div>
                    {/if}
                  </div>
                </fieldset>
              {/each}
            </div>
          {/if}

          <div class="model-save-row">
            <button class="btn save-settings" type="button" onclick={saveModelCatalog} disabled={modelCatalogSaving || modelCatalogLoading || modelCatalogError !== ''}>
              {#if modelCatalogSaving}<LoaderCircle class="spin" size={13} strokeWidth={1.8} /> Saving…{:else}Save models <Check size={13} strokeWidth={1.8} />{/if}
            </button>
          </div>
        </section>
        </div>
      {:else if settingsPage === 'mcp'}
<div class="settings-form">
        <section class="mcp-settings" aria-labelledby="mcp-settings-title">
          <h3 id="mcp-settings-title">MCP servers</h3>
          <div class="mcp-settings-heading">
            <div>
              <p>Attach local Docker or HTTP tool servers to the DSH runtime.</p>
            </div>
            <button class="btn mcp-add" data-variant="outline" type="button" onclick={addMcpServer}>
              <Plus size={13} strokeWidth={1.8} /> Add server
            </button>
          </div>

          {#if mcpServers.length === 0}
            <div class="mcp-empty">
              <Server size={15} strokeWidth={1.7} />
              <span>No MCP servers configured.</span>
            </div>
          {:else}
            <div class="mcp-server-list">
              {#each mcpServers as server, serverIndex (server)}
                <fieldset class="mcp-server-card">
                  <legend>
                    <span class="mcp-server-title"><Server size={13} strokeWidth={1.7} /> {server.serverName || 'Unnamed server'}</span>
                    <button class="btn icon-button mcp-remove" data-variant="ghost" data-size="icon" type="button" aria-label={`Remove ${server.serverName || 'MCP server'}`} title="Remove MCP server" onclick={() => removeMcpServer(serverIndex)}>
                      <Trash2 size={13} strokeWidth={1.8} />
                    </button>
                  </legend>

                  <div class="mcp-grid">
                    <div class="field" role="group">
                      <label for={`mcp-name-${serverIndex}`}>Server name</label>
                      <input id={`mcp-name-${serverIndex}`} class="input" bind:value={server.serverName} placeholder="Server name" autocomplete="off" />
                      <small>Used in tool names</small>
                    </div>

                    <div class="field" role="group">
                      <label for={`mcp-transport-${serverIndex}`}>Transport</label>
                      <select id={`mcp-transport-${serverIndex}`} class="select" bind:value={server.transport}>
                        <option value="stdio">Local process / Docker</option>
                        <option value="streamable-http">Streamable HTTP</option>
                      </select>
                    </div>
                  </div>

                  {#if server.transport === 'stdio'}
                    <div class="field" role="group">
                      <label for={`mcp-command-${serverIndex}`}>Command</label>
                      <input id={`mcp-command-${serverIndex}`} class="input" bind:value={server.command} placeholder="Executable or path" autocomplete="off" />
                      <small>DSH starts this command when the runtime starts.</small>
                    </div>

                    <div class="field" role="group">
                      <label for={`mcp-args-${serverIndex}`}>Arguments</label>
                      <textarea id={`mcp-args-${serverIndex}`} class="textarea mcp-args" bind:value={server.argsText} rows="4"></textarea>
                      <small>One argument per line.</small>
                    </div>
                  {:else}
                    <div class="field" role="group">
                      <label for={`mcp-url-${serverIndex}`}>MCP URL</label>
                      <input id={`mcp-url-${serverIndex}`} class="input" type="url" bind:value={server.url} placeholder="http://localhost:3000/mcp" autocomplete="off" />
                    </div>
                  {/if}

                  {#if server.transport === 'stdio'}
                    <div class="mcp-env-heading">
                      <div>
                        <span>Environment variables</span>
                        <small>Values are kept in VS Code SecretStorage and are not written to settings.</small>
                      </div>
                      <button class="btn icon-button" data-variant="ghost" data-size="icon" type="button" aria-label="Add environment variable" title="Add environment variable" onclick={() => addMcpEnvironment(serverIndex)}>
                        <Plus size={13} strokeWidth={1.8} />
                      </button>
                    </div>
                    {#if server.env.length > 0}
                      <div class="mcp-env-list">
                        {#each server.env as environment, environmentIndex (environmentIndex)}
                          <div class="mcp-env-row">
                            <input class="input" bind:value={environment.name} placeholder="ENVIRONMENT_NAME" aria-label="Environment variable name" autocomplete="off" />
                            <input class="input" type="password" bind:value={environment.value} placeholder={environment.configured ? 'Saved value — enter to replace' : 'Secret value'} aria-label="Environment variable value" autocomplete="new-password" />
                            <button class="btn icon-button" data-variant="ghost" data-size="icon" type="button" aria-label="Remove environment variable" title="Remove environment variable" onclick={() => removeMcpEnvironment(serverIndex, environmentIndex)}>
                              <X size={13} strokeWidth={1.8} />
                            </button>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  {:else}
                    <small class="mcp-http-note">HTTP authentication headers are not configured in this editor yet.</small>
                  {/if}
                </fieldset>
              {/each}
            </div>
          {/if}
        </section>
        <div class="settings-footer">
          <span></span>
          <button class="btn save-settings" type="button" onclick={saveMcpServers} disabled={mcpSaving || settingsRestarting}>
            {#if mcpSaving || settingsRestarting}<LoaderCircle class="spin" size={13} strokeWidth={1.8} /> Applying…{:else}Save MCP servers <Check size={13} strokeWidth={1.8} />{/if}
          </button>
        </div>
      </div>
      {:else}
          <div class="request-preview-panel">
            <div class="request-preview-heading">
              <h3>Preview the first model request</h3>
              <p>Build the DSH request for a fresh chat using the selected provider, model, and configured default reasoning effort. Nothing is sent to the model.</p>
            </div>
            <form class="request-preview-form" onsubmit={(event) => { event.preventDefault(); submitRequestPreview() }}>
              <label for="request-preview-prompt">Prompt</label>
              <div class="request-preview-input-row">
                <input id="request-preview-prompt" class="input" type="text" bind:value={requestPreviewPrompt} placeholder="Enter a prompt and press Enter" autocomplete="off" disabled={requestPreviewState === 'loading'} />
                <button class="btn request-preview-submit" type="submit" disabled={requestPreviewState === 'loading' || !requestPreviewPrompt.trim()}>
                  {#if requestPreviewState === 'loading'}<LoaderCircle class="spin" size={13} strokeWidth={1.8} /> Building…{:else}Preview{/if}
                </button>
                {#if requestPreviewState === 'loading'}
                  <button class="btn" data-variant="outline" type="button" onclick={cancelRequestPreview}>Cancel</button>
                {/if}
              </div>
            </form>
            {#if requestPreviewState === 'loading'}
              <p class="request-preview-status" role="status"><LoaderCircle class="spin" size={12} strokeWidth={1.8} /> Starting an isolated DSH session and assembling the request…</p>
            {:else if requestPreviewState === 'error'}
              <p class="request-preview-status error" role="alert">{requestPreviewError}</p>
            {:else if requestPreviewState === 'cancelled'}
              <p class="request-preview-status" role="status">Preview cancelled.</p>
            {:else if requestPreview}
              {@const previewView = createRequestPreviewView(requestPreview)}
              <div class="request-preview-result-toggle field" role="group" data-orientation="horizontal">
                <section>
                  <label for="request-preview-raw-json">Show raw JSON</label>
                  <p>Switch between the readable breakdown and the captured request.</p>
                </section>
                <input id="request-preview-raw-json" type="checkbox" role="switch" class="input" bind:checked={showRawRequestJson} />
              </div>
              {#if showRawRequestJson}
                <pre class="request-preview-output" aria-label="Canonical DSH request"><code>{JSON.stringify(requestPreview.request, null, 2)}</code></pre>
              {:else}
                <div class="request-preview-readable" aria-label="Readable DSH request">
                  <div class="request-preview-route">
                    <div><span>Provider</span><strong>{previewView.provider}</strong></div>
                    <div><span>Model</span><strong>{previewView.model}</strong></div>
                  </div>
                  <div class="request-preview-options" aria-label="Generation settings">
                    {#each previewView.details as detail (detail.label)}
                      <div><span>{detail.label}</span><strong>{detail.value}</strong></div>
                    {/each}
                  </div>
                  <section class="request-preview-prompt" aria-labelledby="request-preview-prompt-heading">
                    <h4 id="request-preview-prompt-heading">Prompt</h4>
                    {#if previewView.promptItems.length === 0}
                      <p class="request-preview-status">No prompt messages were captured.</p>
                    {:else}
                      {#each previewView.promptItems as item, index (`${index}:${item.role}`)}
                        <article class="request-preview-message">
                          <header>
                            <strong>{item.role}</strong>
                            {#if item.source}<span>{item.source}</span>{/if}
                          </header>
                          {#if item.sections && item.sections.length > 0}
                            <div class="request-preview-sections">
                              {#each item.sections as section, sectionIndex (`${index}:${sectionIndex}:${section.name}`)}
                                <section class="request-preview-section-card">
                                  <h5>{section.name}</h5>
                                  <pre>{section.text}</pre>
                                </section>
                              {/each}
                            </div>
                          {:else}
                            <pre>{item.text}</pre>
                          {/if}
                        </article>
                      {/each}
                    {/if}
                  </section>
                  <section class="request-preview-tools" aria-labelledby="request-preview-tools-heading">
                    <h4 id="request-preview-tools-heading">Tools available to the model <span>{previewView.tools.length}</span></h4>
                    {#if previewView.tools.length === 0}
                      <p class="request-preview-status">No tools are available for this request.</p>
                    {:else}
                      <section class="accordion request-preview-tool-list" data-multiple>
                        {#each previewView.tools as tool, index (`${index}:${tool.name}`)}
                          <details>
                            <summary><span>{tool.name}</span><ChevronDown size={13} strokeWidth={1.8} /></summary>
                            <section class="request-preview-tool-content">
                              {#if tool.description}<p>{tool.description}</p>{/if}
                              <h5>Parameters</h5>
                              <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
                            </section>
                          </details>
                        {/each}
                      </section>
                    {/if}
                  </section>
                </div>
              {/if}
            {:else}
              <p class="request-preview-status">The assembled request will appear here.</p>
            {/if}
          </div>
      {/if}
      <p class:success={settingsStatusTone === 'success'} class:warning={settingsStatusTone === 'warning'} class="settings-status" role="status">{settingsStatus}</p>
    </section>
  {:else}
    <section class="chat-view">
      <div class="transcript" bind:this={transcriptElement} onscroll={handleTranscriptScroll} aria-live="polite">
        {#each messages as message (message.id)}
          <article class="message" class:user={message.role === 'user'} class:assistant={message.role === 'assistant'} class:reasoning={message.role === 'reasoning'} class:activity={message.role === 'activity'} class:tool={message.role === 'tool'}>
            {#if message.role === 'compaction' && message.compaction}
              <CompactionCard entry={message.compaction} subagent={message.compaction.sessionId !== activeSessionId} />
            {:else if message.role === 'reasoning'}
              <details class="thinking" class:active={isGenerating && !waitingForAnswer && activeThinkingId === message.id} aria-busy={isGenerating && !waitingForAnswer && activeThinkingId === message.id}>
                <summary><span class="thinking-label">{message.label}</span><ChevronDown class="thinking-chevron" size={13} strokeWidth={1.8} /></summary>
                <div class="message-body" use:followThinkingStream>{message.text}</div>
              </details>
            {:else if message.role === 'tool' && message.tool}
              {#if message.tool.question}
                <UserQuestionCard value={message.tool.question} onanswer={(answer) => answerQuestion(message.tool!.question!, answer)} />
              {:else}
              <details open={message.tool.approval?.status === 'pending'} class:completed={message.tool.status === 'completed'} class:failed={message.tool.status === 'error'} class="tool-details">
                <summary>
                  <Wrench size={13} strokeWidth={1.7} />
                  <span class="tool-name">{message.tool.name}</span>
                  <ArrowRight class="tool-flow-arrow" size={12} strokeWidth={1.7} />
                  <span class:error={message.tool.status === 'error' || message.tool.approval?.status === 'rejected'} class:running={(message.tool.status === 'preparing' || message.tool.status === 'running') && message.tool.approval?.status === undefined} class="tool-status" aria-live="polite">
                    {#if message.tool.status === 'preparing'}<LoaderCircle class="spin" size={11} strokeWidth={1.8} aria-hidden="true" />{/if}
                    {toolStatusLabel(message.tool)}
                  </span>
                  <ChevronDown class="tool-chevron" size={13} strokeWidth={1.8} />
                </summary>
                <div class="tool-panel">
                  {#if message.tool.approval}
                    <div class="tool-section tool-approval" class:pending={message.tool.approval.status === 'pending'}>
                      <div class="tool-section-label">Permission</div>
                      {#if message.tool.approval.reason}<div class="tool-approval-reason">{message.tool.approval.reason}</div>{/if}
                      {#if message.tool.approval.status === 'pending'}
                        <div class="tool-approval-actions">
                          <button class="btn" data-variant="outline" data-size="xs" type="button" onclick={() => decideApproval(message.tool!, 'allowed-once')} disabled={message.tool.approval.decisionPending}>
                            <Check size={12} strokeWidth={1.8} /> Allow once
                          </button>
                          <button class="btn" data-variant="destructive" data-size="xs" type="button" onclick={() => decideApproval(message.tool!, 'rejected')} disabled={message.tool.approval.decisionPending}>
                            <X size={12} strokeWidth={1.8} /> Deny
                          </button>
                        </div>
                      {:else}
                        <div class="tool-approval-result">{approvalResultLabel(message.tool.approval.status)}</div>
                      {/if}
                    </div>
                  {/if}
                  {#if message.tool.status !== 'preparing'}
                    <div class="tool-section">
                      <div class="tool-section-label">Arguments</div>
                      <pre class="tool-payload">{formatToolArguments(message.tool.arguments)}</pre>
                    </div>
                  {:else}
                    <div class="tool-section">Generating tool request…</div>
                  {/if}
                  {#if message.tool.result}
                    <div class="tool-section">
                      <div class="tool-section-label">Result</div>
                      <div class="tool-payload markdown">{@html renderMarkdown(message.tool.result)}</div>
                    </div>
                  {/if}
                  {#if message.tool.meta}
                    <div class="tool-section">
                      <div class="tool-section-label">Metadata</div>
                      <pre class="tool-payload">{message.tool.meta}</pre>
                    </div>
                  {/if}
                  {#if message.tool.error}
                    <div class="tool-section tool-error">
                      <div class="tool-section-label">Error</div>
                      <div class="tool-payload">{message.tool.error}</div>
                    </div>
                  {/if}
                </div>
              </details>
              {/if}
            {:else}
              {#if message.role === 'user' && message.context}
                <div class="message-context" title={`${message.context.fileLabel} · ${selectionLineLabel(message.context)}`}>
                  <Code2 size={12} strokeWidth={1.7} />
                  <span class="message-context-file">{message.context.fileLabel}</span>
                  <span class="message-context-lines">{selectionLineLabel(message.context)}</span>
                </div>
              {/if}
              {#if message.role === 'user' && message.browserLabels?.length}
                <div class="message-context" aria-label="Attached browser elements">
                  <MousePointer2 size={12} />
                  <span class="message-context-file">{message.browserLabels.join(', ')}</span>
                </div>
              {/if}
              {#if message.role === 'assistant'}
                <div class="message-body markdown">{@html renderMarkdown(message.text)}</div>
              {:else}
                <div class="message-body">{message.text}</div>
              {/if}
            {/if}
          </article>
        {/each}
        {#if waitingForFirstResponse}
          <article class="message activity waiting-for-response" role="status">
            <LoaderCircle class="spin" size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>Waiting for the model…</span>
          </article>
        {/if}
        {#if codeChanges.length > 0 && !isGenerating}
          <section class:open={changesOpen} class="changes-summary-card" aria-label="Agent changes summary">
            <button class="btn changes-toggle" data-variant="ghost" type="button" aria-expanded={changesOpen} onclick={() => { changesOpen = !changesOpen }}>
              <span class="changes-title"><FileDiff size={13} strokeWidth={1.8} /> <span>Changes</span><span class="changes-count">{codeChanges.length}</span></span>
              <span class="changes-summary">{changeSummaryLabel()}</span>
              <ChevronDown class="changes-chevron" size={13} strokeWidth={1.8} />
            </button>
            <div class="changes-panel">
              <div class="changes-panel-inner">
                <div class="changes-list changes-summary-list">
                  {@render changeRows()}
                </div>
              </div>
            </div>
          </section>
        {/if}
      </div>

      <div class="composer">
        {#if skillPickerEnabled}<SkillsDrawer skills={skillCatalog.skills} suggestions={skillSuggestions} overrides={skillOverrides} disabled={Boolean(pendingSubmission)} error={skillError} onoverride={(value) => { skillOverrides = value }} />{/if}
        {#if browserContext?.attachments.length}
          <BrowserAttachments attachments={browserContext.attachments} disabled={isGenerating} onremove={(id) => post({ type: 'removeBrowserAttachment', sessionId: activeSessionId, id })} />
        {/if}
        {#if selection && selectionAttached}
          <div class="context-chip">
            <Code2 size={14} strokeWidth={1.7} />
            <div class="context-copy">
              <div class="context-file">{selection.fileLabel}</div>
              <span class="context-separator" aria-hidden="true">·</span>
              <div class="context-range">
                {selectionLineLabel(selection)}
                <span class="context-separator" aria-hidden="true">·</span>
                {selection.languageId || 'plain text'}
              </div>
            </div>
            <button class="btn remove-context" data-variant="ghost" data-size="icon" type="button" aria-label="Remove editor context" title="Remove editor context" onclick={() => selectionAttached = false}>
              <X size={14} strokeWidth={1.8} />
            </button>
          </div>
        {/if}
        {#if codeChanges.length > 0 && isGenerating}
          <section class:open={changesOpen} class="changes-drawer" aria-label="Agent changes">
            <button class="btn changes-toggle" data-variant="ghost" type="button" aria-expanded={changesOpen} onclick={() => { changesOpen = !changesOpen }}>
              <span class="changes-title"><FileDiff size={13} strokeWidth={1.8} /> <span>Changes</span><span class="changes-count">{codeChanges.length}</span></span>
              <span class="changes-summary">{changeSummaryLabel()}</span>
              <ChevronDown class="changes-chevron" size={13} strokeWidth={1.8} />
            </button>
            <div class="changes-panel">
              <div class="changes-panel-inner">
                <div class="changes-list">
                  {@render changeRows()}
                </div>
              </div>
            </div>
          </section>
        {/if}
        <div class="composer-box" class:working={isGenerating && !waitingForAnswer}>
          <textarea disabled={Boolean(pendingSubmission)} bind:this={promptElement} class="textarea" bind:value={prompt} onkeydown={handlePromptKeydown} placeholder="Ask about your code..." aria-label="Prompt" rows="2"></textarea>
          <div class="composer-footer">
            {#if browserContext?.hasOpenBrowser}
              <span class="browser-picker-control" data-side="top" data-align="start" data-tooltip={browserContext?.picking ? 'Stop selecting browser elements' : browserContext?.available ? 'Select browser elements' : 'Browser picker setup required. Use Helix: Select Browser Elements.'}>
                <button class="btn" data-variant="ghost" data-size="icon-sm" type="button" aria-label={browserContext?.picking ? 'Stop selecting browser elements' : 'Select browser elements'} aria-pressed={browserContext?.picking ?? false} disabled={!browserContext?.available || (isGenerating && !browserContext?.picking)} onclick={() => post({ type: 'toggleBrowserPicker' })}><MousePointer2 size={15} strokeWidth={1.8} /></button>
              </span>
            {/if}
            <div class="model-picker-wrap">
              <div id="composer-model-selector" class="popover composer-model-selector">
                <button
                  id="composer-model-trigger"
                  class="btn composer-tooltip"
                  data-variant="ghost"
                  data-size="icon-sm"
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded="false"
                  aria-controls="composer-model-popover"
                  aria-label={composerModelEffortLabel()}
                  data-tooltip={composerModelEffortLabel()}
                  data-side="top"
                  data-align="end"
                >
                  <Brain size={16} strokeWidth={1.8} aria-hidden="true" />
                </button>
                <div
                  id="composer-model-popover"
                  data-popover
                  data-side="top"
                  data-align="end"
                  aria-hidden="true"
                  role="dialog"
                  aria-label="Model and reasoning"
                >
                  <section class="composer-model-section" aria-labelledby="composer-effort-options-title">
                    <h4 id="composer-effort-options-title">Reasoning effort</h4>
                    {#if !model}
                      <p class="composer-model-status">Choose a model to see its defined levels.</p>
                    {:else if selectedModelEfforts().length === 0}
                      <p class="composer-model-status">This model has no selectable reasoning levels.</p>
                    {:else}
                      <div class="composer-model-options" role="group" aria-labelledby="composer-effort-options-title">
                        {#each selectedModelEfforts() as effort (`${model}-${effort}`)}
                          <button
                            class="btn composer-model-option"
                            data-variant="ghost"
                            type="button"
                            aria-pressed={reasoningEffort === effort}
                            onclick={() => selectComposerReasoningEffort(effort)}
                          >
                            <span>{effort}</span>
                            {#if reasoningEffort === effort}<Check size={12} strokeWidth={2} aria-hidden="true" />{/if}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </section>
                  <section class="composer-model-section" aria-labelledby="composer-model-options-title">
                    <h4 id="composer-model-options-title">Model</h4>
                    <div class="composer-model-options" role="group" aria-labelledby="composer-model-options-title">
                      {#if models.length === 0}
                        <p class="composer-model-status" role="status">No saved models. Add one in Settings.</p>
                      {:else}
                        {#each models as option (option.id)}
                          <button
                            class="btn composer-model-option"
                            data-variant="ghost"
                            type="button"
                            aria-pressed={model === option.id}
                            disabled={modelChanging}
                            onclick={() => handleComposerModelSelection(option.id)}
                          >
                            <span>{modelOptionLabel(option)}</span>
                            {#if model === option.id}<Check size={12} strokeWidth={2} aria-hidden="true" />{/if}
                          </button>
                        {/each}
                      {/if}
                    </div>
                  </section>
                </div>
              </div>
            </div>
            <span id="send-context-description" class="sr-only">{contextMeterLabel()}</span>
            <span
              class="context-send composer-tooltip"
              style={`--context-progress: ${contextProgress()}%`}
              data-tooltip={contextMeterLabel()}
              data-side="top"
              data-align="end"
            >
              <button class="btn send" data-size="icon-sm" type="button" aria-label={isGenerating || waitingForAnswer ? 'Stop generation' : 'Send message'} aria-describedby="send-context-description" onclick={submit} disabled={!isGenerating && !waitingForAnswer && !prompt.trim()}>
                {#if isGenerating || waitingForAnswer}<Square size={13} strokeWidth={1.8} />{:else}<ArrowUp size={14} strokeWidth={1.8} />{/if}
              </button>
            </span>
          </div>
        </div>
      </div>
    </section>
  {/if}
</main>
