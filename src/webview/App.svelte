<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import {
    ArrowLeft,
    Code2,
    MousePointer2,
    LoaderCircle,
  } from '@lucide/svelte'
  import { renderMarkdown } from './markdown.js'
  import { LiveToolCallTracker } from '../shared/live-tool-call-tracker.js'
  import { StreamedStepTracker } from '../shared/streamed-step-tracker.js'
  import { CompactionHistory, type CompactionEntry } from '../shared/compaction-history.js'
  import CompactionCard from './components/CompactionCard.svelte'
  import AboutSettings from './components/AboutSettings.svelte'
  import type { ExtensionInfo } from '../shared/extension-info.js'
  import {
    preferredReasoningEffort,
    selectableReasoningEfforts,
    type ChatTemplateValue,
  } from '../runtime/model-catalog.js'
  import ConnectionSettings from './components/ConnectionSettings.svelte'
  import { DEFAULT_DECISION_SETTINGS, recentChatContext, type DecisionSettings, type SkillCatalog, type SkillDraft, type SkillOverrides, type SkillSuggestions } from '../shared/skills.js'
  import Masthead from './components/Masthead.svelte'
  import UserQuestionCard from './components/UserQuestionCard.svelte'
  import ToolCallCard from './components/ToolCallCard.svelte'
  import ModelsSettings from './components/ModelsSettings.svelte'
  import McpSettings from './components/McpSettings.svelte'
  import RequestPreviewPanel from './components/RequestPreviewPanel.svelte'
  import ChangesPanel from './components/ChangesPanel.svelte'
  import ThinkingCard from './components/ThinkingCard.svelte'
  import Composer from './components/Composer.svelte'
  import { formatTokenCount, selectionLineLabel } from './formatting.js'
  import { validateQuestionAnswer, type PendingUserQuestion, type UserQuestionAnswer, type UserQuestionView } from '../shared/user-question.js'
  import type { BrowserContextState } from '../shared/browser-context.js'
  import { countLines, isRecord, parsePayload, responseKey, stringValue } from '../shared/value-utils.js'
  import type {
    ApprovalView,
    ToolCallView,
    HarnessEvent,
    HarnessNotification,
    IncomingMessage,
    CodeChange,
    RuntimeState,
    SelectionMetadata,
    SandboxMode,
    SidebarMessage,
    McpServerDraft,
    SidebarMcpEnvironment,
    SidebarMcpServer,
    SidebarMcpServerSetting,
    SidebarDiscoveredModel,
    SidebarModel,
    RequestPreviewResult,
    ModelDraft,
    ModelEditorDraft,
    SidebarSettings,
    SettingsPage,
    WebviewApi,
  } from './types.js'

  interface Props {
    vscode: WebviewApi
  }

  interface ChatMessage {
    id: number
    role: 'user' | 'assistant' | 'reasoning' | 'activity' | 'tool' | 'compaction' | 'changes'
    label: string
    text: string
    context?: SelectionMetadata
    browserLabels?: string[]
    tool?: ToolCallView
    compaction?: CompactionEntry
    changes?: CodeChange[]
    panelOpen?: boolean
  }

  interface StreamUpdate {
    role: 'assistant' | 'reasoning'
    text: string
  }

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
  let composer = $state<{ focus: () => void }>()
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

    if (codeChanges.length > 0) {
      messages = [...messages, {
        id: nextMessageId++,
        role: 'changes',
        label: 'Changes',
        text: '',
        changes: codeChanges.map((change) => ({ ...change })),
        panelOpen: changesOpen,
      }]
      codeChanges = []
      changesOpen = false
    }

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
    void tick().then(() => composer?.focus())
  }

  function startNewSession(): void {
    waitingForFirstResponse = false
    post({ type: 'newSession' })
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

  function handleAddDiscoveredModel(selectedId: string): void {
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

  function selectedEffortsForModel(modelId: string): string[] {
    return selectableReasoningEfforts(models.find((entry) => entry.id === modelId))
  }

  function preferredEffortForModel(modelId: string): string | null {
    return preferredReasoningEffort(models.find((entry) => entry.id === modelId), reasoningHistory[modelId]) ?? null
  }

  function selectComposerReasoningEffort(value: string): void {
    if (selectedEffortsForModel(model).includes(value)) reasoningEffort = value
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
          reasoningEfforts: [...draft.reasoningEfforts],
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

  function modelOptionLabel(option: SidebarModel): string {
    const name = option.displayName ?? option.id
    const context = option.contextWindow === undefined ? '' : ` · ${formatTokenCount(option.contextWindow)}`
    return `${name}${context}`
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

  function stringifyPayload(value: unknown): string {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value, null, 2) ?? ''
    } catch {
      return String(value)
    }
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
        <ConnectionSettings
          bind:provider
          bind:baseUrl
          bind:apiKey
          bind:clearApiKey
          bind:sandboxMode
          bind:decisions
          bind:decisionApiKey={decisionsApiKey}
          bind:clearDecisionApiKey={clearDecisionsApiKey}
          apiKeyConfigured={settings?.apiKeyConfigured ?? false}
          decisionKeyConfigured={settings?.decisions?.apiKeyConfigured ?? false}
          {skillPickerEnabled}
          {settingsRestarting}
          onSave={saveSettings}
          onStatus={setSettingsStatus}
        />
      {:else if settingsPage === 'models'}
        <ModelsSettings
          bind:modelDrafts
          {discoveredModels}
          {modelsLoading}
          {modelsError}
          {modelCatalogLoading}
          {modelCatalogSaving}
          {modelCatalogError}
          {modelOptionLabel}
          onAddModel={handleAddDiscoveredModel}
          onRefreshModels={refreshModels}
          onSaveModels={saveModelCatalog}
          onStatus={setSettingsStatus}
        />
      {:else if settingsPage === 'mcp'}
        <McpSettings
          bind:mcpServers
          {mcpSaving}
          {settingsRestarting}
          onSave={saveMcpServers}
        />
      {:else}
        <RequestPreviewPanel
          bind:prompt={requestPreviewPrompt}
          bind:showRawJson={showRawRequestJson}
          state={requestPreviewState}
          preview={requestPreview}
          error={requestPreviewError}
          onPreview={submitRequestPreview}
          onCancel={cancelRequestPreview}
        />
      {/if}
      <p class:success={settingsStatusTone === 'success'} class:warning={settingsStatusTone === 'warning'} class="settings-status" role="status">{settingsStatus}</p>
    </section>
  {:else}
    <section class="chat-view">
      <div class="transcript" bind:this={transcriptElement} onscroll={handleTranscriptScroll} aria-live="polite">
        {#each messages as message (message.id)}
          {#if message.role === 'changes' && message.changes}
            <ChangesPanel changes={message.changes} bind:open={message.panelOpen} variant="summary" />
          {:else}
            <article class="message" class:user={message.role === 'user'} class:assistant={message.role === 'assistant'} class:reasoning={message.role === 'reasoning'} class:activity={message.role === 'activity'} class:tool={message.role === 'tool'}>
              {#if message.role === 'compaction' && message.compaction}
                <CompactionCard entry={message.compaction} subagent={message.compaction.sessionId !== activeSessionId} />
              {:else if message.role === 'reasoning'}
                <ThinkingCard label={message.label} text={message.text} active={isGenerating && !waitingForAnswer && activeThinkingId === message.id} />
              {:else if message.role === 'tool' && message.tool}
                {#if message.tool.question}
                  <UserQuestionCard value={message.tool.question} onanswer={(answer) => answerQuestion(message.tool!.question!, answer)} />
                {:else}
                  <ToolCallCard tool={message.tool} onapprove={(outcome) => decideApproval(message.tool!, outcome)} />
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
          {/if}
        {/each}
        {#if waitingForFirstResponse}
          <article class="message activity waiting-for-response" role="status">
            <LoaderCircle class="spin" size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>Waiting for the model…</span>
          </article>
        {/if}
        {#if codeChanges.length > 0 && !isGenerating}
          <ChangesPanel changes={codeChanges} bind:open={changesOpen} variant="summary" />
        {/if}
      </div>

      <Composer
        bind:this={composer}
        bind:prompt
        bind:selectionAttached
        bind:changesOpen
        bind:skillOverrides
        {isGenerating}
        {waitingForAnswer}
        submissionPending={Boolean(pendingSubmission)}
        {selection}
        {browserContext}
        {codeChanges}
        {models}
        {model}
        {reasoningEffort}
        {modelChanging}
        {contextUsedTokens}
        {contextWindowTokens}
        {skillPickerEnabled}
        skills={skillCatalog.skills}
        {skillSuggestions}
        {skillError}
        {modelOptionLabel}
        onSubmit={submit}
        onModelSelect={handleComposerModelSelection}
        onReasoningEffortSelect={selectComposerReasoningEffort}
        onRemoveBrowserAttachment={(id) => post({ type: 'removeBrowserAttachment', sessionId: activeSessionId, id })}
        onToggleBrowserPicker={() => post({ type: 'toggleBrowserPicker' })}
      />
    </section>
  {/if}
</main>
