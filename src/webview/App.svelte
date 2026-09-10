<script lang="ts">
  import { onMount, tick } from 'svelte'
  import {
    ArrowLeft,
    ArrowRight,
    Check,
    ChevronDown,
    Code2,
    Eye,
    FileDiff,
    FolderPen,
    LoaderCircle,
    Plus,
    RefreshCw,
    Server,
    Send,
    ShieldAlert,
    Settings2,
    Square,
    Trash2,
    Wrench,
    X,
  } from '@lucide/svelte'
  import { renderMarkdown } from './markdown.js'
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
    SidebarModel,
    SidebarSettings,
    WebviewApi,
  } from './types.js'

  interface Props {
    vscode: WebviewApi
  }

  interface ChatMessage {
    id: number
    role: 'user' | 'assistant' | 'reasoning' | 'activity' | 'tool'
    label: string
    text: string
    context?: SelectionMetadata
    tool?: ToolCallView
  }

  interface ToolCallView {
    callId: string
    name: string
    arguments: string
    result?: string
    meta?: string
    error?: string
    status: 'running' | 'completed' | 'error'
    approval?: ApprovalView
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

  let { vscode }: Props = $props()

  let activeSessionId = $state('')
  let runtimeState = $state<RuntimeState>('stopped')
  let selection = $state<SelectionMetadata | undefined>()
  let selectionAttached = $state(true)
  let messages = $state<ChatMessage[]>([])
  let prompt = $state('')
  let isGenerating = $state(false)
  let showSettings = $state(false)
  let settings = $state<SidebarSettings | undefined>()
  let provider = $state('')
  let model = $state('')
  let baseUrl = $state('')
  let apiKey = $state('')
  let sandboxMode = $state<SandboxMode>('workspace-write')
  let clearApiKey = $state(false)
  let settingsStatus = $state('')
  let settingsStatusTone = $state<'success' | 'warning' | ''>('')
  let settingsRestarting = $state(false)
  let contextUsedTokens = $state<number | undefined>()
  let contextWindowTokens = $state<number | undefined>()
  let contextWindowOverride = $state<number | undefined>()
  let modelChanging = $state(false)
  let models = $state<SidebarModel[]>([])
  let modelsLoading = $state(false)
  let modelsError = $state('')
  let mcpServers = $state<McpServerDraft[]>([])
  let codeChanges = $state<CodeChange[]>([])
  let changesOpen = $state(false)
  let changesActive = $state(false)
  let hostChangesStarted = false
  let nextMessageId = 1
  let transcriptElement = $state<HTMLDivElement>()
  let promptElement = $state<HTMLTextAreaElement>()
  let modelPickerElement = $state<HTMLDivElement>()
  let sandboxPickerElement = $state<HTMLDivElement>()
  let streamFrame: number | undefined
  let streamQueue: StreamUpdate[] = []
  let streamedSteps: Record<string, boolean> = {}
  let toolCallsByStep: Record<string, string> = {}
  let pendingCodeChanges: Record<string, CodeChange> = {}
  let pendingApprovalRequests: Record<string, Extract<IncomingMessage, { type: 'approvalRequest' }> & { approval: ApprovalView }> = {}
  let toolDerivedPaths = new Set<string>()

  onMount(() => {
    const listener = (event: MessageEvent<IncomingMessage>) => handleMessage(event.data)
    window.addEventListener('message', listener)
    modelsLoading = true
    vscode.postMessage({ type: 'ready' })
    void tick().then(initializeSandboxPicker)

    return () => {
      window.removeEventListener('message', listener)
      if (streamFrame !== undefined) cancelAnimationFrame(streamFrame)
    }
  })

  function post(message: SidebarMessage): void {
    vscode.postMessage(message)
  }

  function handleMessage(message: IncomingMessage): void {
    if (message.type === 'state') {
      activeSessionId = message.state.activeSessionId
      runtimeState = message.state.runtimeState
      if (runtimeState === 'stopped' || runtimeState === 'error') isGenerating = false
      selection = message.state.selection
      selectionAttached = true
      if (runtimeState === 'ready' && settingsRestarting) {
        settingsRestarting = false
        modelChanging = false
        setSettingsStatus('Saved. Runtime ready.', 'success')
      }
      if (message.resetTranscript) {
        resetTranscript()
      }
      return
    }

    if (message.type === 'selection') {
      selection = message.selection
      selectionAttached = true
      return
    }

    if (message.type === 'codeChanges') {
      if (message.sessionId !== activeSessionId) return
      if (message.active && !hostChangesStarted) {
        hostChangesStarted = true
        codeChanges = []
        changesOpen = false
        pendingCodeChanges = {}
        toolDerivedPaths = new Set()
      }
      if (message.changes.length > 0) codeChanges = mergeHostChanges(codeChanges, message.changes)
      changesActive = message.active
      if (codeChanges.length > 0 && !changesOpen) {
        changesOpen = true
      }
      if (!message.active) {
        hostChangesStarted = false
        void scrollToBottom()
      }
      return
    }

    if (message.type === 'settings' || message.type === 'settingsSaved') {
      applySettings(message.settings)
      if (message.type === 'settingsSaved') {
        settingsRestarting = message.restarting
        setSettingsStatus(
          message.restarting ? 'Applying settings…' : 'Saved.',
          message.restarting ? 'warning' : 'success',
        )
      }
      return
    }

    if (message.type === 'models') {
      models = message.models
      modelsLoading = false
      modelsError = message.error ?? ''
      const selected = models.find((option) => option.id === model)
      if (selected?.contextWindow !== undefined) {
        contextWindowOverride = selected.contextWindow
        contextWindowTokens = selected.contextWindow
      } else if (contextWindowOverride === undefined) {
        contextWindowTokens = undefined
      }
      void tick().then(refreshModelPicker)
      return
    }

    if (message.type === 'approvalRequest') {
      if (message.sessionId !== activeSessionId) return
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

    if (message.type === 'error') {
      isGenerating = false
      settingsRestarting = false
      modelChanging = false
      if (showSettings) {
        setSettingsStatus(message.message, 'warning')
      }
      else appendMessage('activity', 'Runtime error', message.message)
      return
    }

    if (message.type === 'accepted' && message.sessionId === activeSessionId) {
      isGenerating = true
      runtimeState = 'starting'
    }
  }

  function applySettings(next: SidebarSettings): void {
    settings = next
    provider = next.provider
    model = next.model
    const selected = models.find((option) => option.id === next.model)
    contextWindowOverride = selected?.contextWindow ?? (next.contextWindow > 0 ? next.contextWindow : undefined)
    contextWindowTokens = contextWindowOverride
    baseUrl = next.baseUrl
    sandboxMode = next.sandboxMode
    apiKey = ''
    clearApiKey = false
    mcpServers = next.mcpServers.map(toMcpServerDraft)
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
    if (streamFrame !== undefined) cancelAnimationFrame(streamFrame)
    streamFrame = undefined
    streamQueue = []
    streamedSteps = {}
    toolCallsByStep = {}
    pendingCodeChanges = {}
    toolDerivedPaths = new Set()
    pendingApprovalRequests = {}
    messages = []
    codeChanges = []
    changesOpen = false
    changesActive = false
    hostChangesStarted = false
    isGenerating = false
    contextUsedTokens = undefined
    contextWindowTokens = contextWindowOverride
  }

  function setSettingsStatus(text: string, tone: 'success' | 'warning' | ''): void {
    settingsStatus = text
    settingsStatusTone = tone
  }

  function runtimeLabel(state: RuntimeState): string {
    if (state === 'ready') return 'ready'
    if (state === 'starting') return 'starting'
    if (state === 'error') return 'error'
    return 'stopped'
  }

  function selectionLineLabel(value: SelectionMetadata): string {
    return value.ranges
      .map((range) => range.startLine === range.endLine
        ? `L${range.startLine}`
        : `L${range.startLine}–L${range.endLine}`)
      .join(', ')
  }

  function submit(): void {
    if (isGenerating) {
      post({ type: 'cancelTurn' })
      return
    }

    const text = prompt.trim()
    if (!text) return

    const attachedSelection = selectionAttached ? selection : undefined
    appendMessage('user', 'You', text, attachedSelection)
    isGenerating = true
    post({ type: 'submit', prompt: text, includeSelection: attachedSelection !== undefined })
    prompt = ''
    selectionAttached = true
    void tick().then(() => promptElement?.focus())
  }

  function handlePromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  function refreshModels(): void {
    modelsLoading = true
    modelsError = ''
    post({ type: 'refreshModels' })
  }

  function handleModelChange(event: Event): void {
    const detail = (event as CustomEvent<{ value?: string }>).detail
    const nextModel = typeof detail?.value === 'string' ? detail.value : ''
    if (!nextModel) return

    const selected = models.find((option) => option.id === nextModel)
    const selectedContextWindow = selected?.contextWindow
    model = nextModel
    contextWindowOverride = selectedContextWindow
    contextWindowTokens = selectedContextWindow
    modelChanging = true
    post({ type: 'selectModel', model: nextModel, contextWindow: selectedContextWindow })
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
    post({ type: 'setSandboxMode', sandboxMode: nextMode })
  }

  function appendMessage(role: ChatMessage['role'], label: string, text: string, context?: SelectionMetadata): void {
    messages = [...messages, { id: nextMessageId++, role, label, text, context }]
    void scrollToBottom()
  }

  function queueStreamText(role: StreamUpdate['role'], text: string): void {
    streamQueue.push({ role, text })
    if (streamFrame !== undefined) return
    streamFrame = requestAnimationFrame(flushStreamQueue)
  }

  function flushStreamQueue(): void {
    streamFrame = undefined
    const updates = streamQueue
    streamQueue = []
    if (updates.length === 0) return

    const next = [...messages]
    for (const update of updates) {
      const last = next[next.length - 1]
      if (last?.role === update.role) {
        next[next.length - 1] = { ...last, text: last.text + update.text }
      } else {
        next.push({
          id: nextMessageId++,
          role: update.role,
          label: update.role === 'reasoning' ? 'Thinking' : 'Helix',
          text: update.text,
        })
      }
    }
    messages = next
    void scrollToBottom()
  }

  async function scrollToBottom(): Promise<void> {
    await tick()
    if (transcriptElement) transcriptElement.scrollTop = transcriptElement.scrollHeight
  }

  function responseKey(data: Record<string, unknown>): string {
    return Number.isInteger(data.turn) && Number.isInteger(data.step)
      ? `${String(data.turn)}:${String(data.step)}`
      : ''
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
    changesActive = true
    changesOpen = true
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

  function modelPickerLabel(): string {
    if (modelsLoading) return 'Loading available models'
    if (modelsError) return modelsError
    const selected = models.find((option) => option.id === model)
    return selected === undefined ? `Model: ${model || 'not selected'}` : `Model: ${modelOptionLabel(selected)}`
  }

  function selectedModelLabel(): string {
    if (modelsLoading) return 'Loading models…'
    const selected = models.find((option) => option.id === model)
    if (selected !== undefined) return modelOptionLabel(selected)
    if (model) return model
    return models.length === 0 ? 'No models found' : 'Select model'
  }

  function refreshModelPicker(): void {
    const picker = modelPickerElement as (HTMLDivElement & { refresh?: () => void }) | undefined
    picker?.refresh?.()
  }

  function initializeSandboxPicker(): void {
    const basecoat = (window as Window & {
      basecoat?: {
        init?: (component: string) => void
      }
    }).basecoat
    basecoat?.init?.('select')
    refreshSandboxPicker()
  }

  function refreshSandboxPicker(): void {
    const picker = sandboxPickerElement as (HTMLDivElement & { refresh?: () => void }) | undefined
    picker?.refresh?.()
  }

  function appendAssistantBlocks(content: unknown): void {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== 'string' || typeof block.text !== 'string') continue
      if (block.type === 'text') queueStreamText('assistant', block.text)
      if (block.type === 'reasoning') queueStreamText('reasoning', block.text)
    }
  }

  function upsertToolCall(tool: ToolCallView): void {
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

  function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  function toolStatusLabel(tool: ToolCallView): string {
    if (tool.approval?.status === 'pending') return tool.approval.decisionPending ? 'sending' : 'approval'
    if (tool.approval?.status === 'allowed-once') return 'allowed once'
    if (tool.approval?.status === 'rejected') return 'denied'
    if (tool.approval?.status === 'cancelled') return 'cancelled'
    if (tool.approval?.status === 'unavailable') return 'unavailable'
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
      if (params.sessionId !== activeSessionId) return
      if (params.status === 'running') {
        isGenerating = true
        runtimeState = 'starting'
      } else {
        isGenerating = false
        runtimeState = 'ready'
        if (codeChanges.length > 0) {
          changesActive = false
          void scrollToBottom()
        }
      }
      return
    }

    if (notification.method === 'subagent.started') {
      appendMessage('activity', 'Subagent', `Started ${String(params.childSessionId || 'child session')}`)
      return
    }

    if (notification.method === 'subagent.finished') {
      appendMessage('activity', 'Subagent', `Finished ${String(params.childSessionId || 'child session')}`)
      return
    }

    if (notification.method !== 'session.event' || !isRecord(params.event)) return
    const event = params.event as HarnessEvent
    const data = isRecord(event.data) ? event.data : {}
    const isRootSessionEvent = params.sessionId === activeSessionId
    const sessionId = stringValue(params.sessionId)

    if (event.type === 'request/context') {
      if (isRootSessionEvent) updateContextWindow(data.contextWindow)
      return
    }

    if (event.type === 'compaction/start') {
      if (isRootSessionEvent) {
        contextUsedTokens = undefined
        appendMessage('activity', 'Context', 'Compacting conversation…')
      }
      return
    }

    if (event.type === 'compaction/summary') {
      if (isRootSessionEvent) {
        const shadowedTokenCount = numericValue(data.shadowedTokenCount)
        const detail = shadowedTokenCount === undefined
          ? 'Conversation compacted; continuing.'
          : `Compacted ${formatTokenCount(shadowedTokenCount)} tokens; continuing.`
        appendMessage('activity', 'Context', detail)
      }
      return
    }

    if (event.type === 'compaction/end') {
      if (isRootSessionEvent && typeof data.error === 'string' && data.error) {
        appendMessage('activity', 'Context', `Compaction failed: ${data.error}`)
      }
      return
    }

    if (event.type === 'assistant/chunk') {
      const chunk = isRecord(data.chunk) ? data.chunk : undefined
      const key = responseKey(data)
      if (key) streamedSteps[key] = true
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') queueStreamText('assistant', chunk.text)
      if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') queueStreamText('reasoning', chunk.text)
      if (isRootSessionEvent && chunk?.type === 'usage') updateContextUsage(chunk.usage)
      return
    }

    if (event.type === 'assistant/message') {
      if (isRootSessionEvent) updateContextUsage(data.usage)
      const key = responseKey(data)
      if (!key || !streamedSteps[key]) {
        const message = isRecord(data.message) ? data.message : {}
        appendAssistantBlocks(message.content)
      }
      return
    }

    if (event.type === 'tool/call') {
      const callId = stringValue(data.callId) ?? (responseKey(data) || `tool-call-${nextMessageId}`)
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
      upsertToolCall({
        callId,
        name: toolName ?? 'Tool call',
        arguments: typeof data.arguments === 'string' ? data.arguments : stringifyPayload(data.arguments),
        status: 'running',
        approval: Object.values(pendingApprovalRequests).find((approval) => approval.toolCallId === callId)?.approval,
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

  function openSettings(): void {
    showSettings = true
    setSettingsStatus('', '')
    post({ type: 'openSettings' })
  }

  function closeSettings(): void {
    showSettings = false
    setSettingsStatus('', '')
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
      sandboxMode,
      mcpServers: mcpServers.map(toMcpServerMessage),
    })
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
    const baseName = 'duckduckgo'
    const serverName = mcpServers.some((server) => server.serverName === baseName)
      ? `mcp-server-${mcpServers.length + 1}`
      : baseName
    mcpServers = [...mcpServers, {
      serverName,
      transport: 'stdio',
      command: 'docker',
      argsText: 'run\n-i\n--rm\nmcp/duckduckgo',
      url: '',
      env: [],
    }]
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

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  function parsePayload(value: unknown): Record<string, unknown> | undefined {
    if (isRecord(value)) return value
    if (typeof value !== 'string') return undefined
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
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

  function countLines(value: string): number {
    return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length
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
  <header class="masthead">
    <div class="title-row">
      <div class="title-copy">
        <h1>Helix</h1>
        <div class="runtime-state">
          <span class:ready={runtimeState === 'ready'} class:starting={runtimeState === 'starting'} class:error={runtimeState === 'error'} class="status-dot"></span>
          {runtimeLabel(runtimeState)}
        </div>
      </div>
      <div class="title-actions">
        <button class="btn icon-button" data-variant="ghost" data-size="icon" type="button" aria-label="New session" title="New session" onclick={() => post({ type: 'newSession' })}>
          <Plus size={15} strokeWidth={1.8} />
        </button>
        <button class="btn icon-button" data-variant="ghost" data-size="icon" type="button" aria-label="Settings" title="Settings" onclick={openSettings}>
          <Settings2 size={15} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  </header>

  {#if showSettings}
    <section class="settings-view" aria-labelledby="settings-heading">
      <div class="settings-heading">
        <button class="btn icon-button" data-variant="ghost" data-size="icon" type="button" aria-label="Back to chat" title="Back to chat" onclick={closeSettings}>
          <ArrowLeft size={15} strokeWidth={1.8} />
        </button>
        <div>
          <h2 id="settings-heading">Connection settings</h2>
          <p>Configure the provider route and connection. Models and context windows come from the provider's models endpoint.</p>
        </div>
      </div>

      <form class="settings-form" onsubmit={(event) => { event.preventDefault(); saveSettings() }}>
        <div class="field" role="group">
          <label for="provider">Provider route</label>
          <input id="provider" class="input" type="text" bind:value={provider} placeholder="deepseek-official" />
          <small>Harness provider route, not the model name.</small>
        </div>

        <div class="field" role="group">
          <label for="base-url">API base URL</label>
          <input id="base-url" class="input" type="url" bind:value={baseUrl} placeholder="https://api.deepseek.com" />
          <small>Leave empty to use the provider default.</small>
        </div>

        <div class="field" role="group">
          <label for="api-key">API key</label>
          <input id="api-key" class="input" type="password" bind:value={apiKey} oninput={() => { if (apiKey) clearApiKey = false }} placeholder={settings?.apiKeyConfigured ? 'Saved key — enter a new key to replace it' : 'Paste an API key'} autocomplete="off" />
          <small class="key-status">
            {#if clearApiKey}<Trash2 size={11} strokeWidth={1.8} /> The saved key will be removed when you save.
            {:else if settings?.apiKeyConfigured}<Check size={11} strokeWidth={1.8} /> A key is currently saved.
            {:else}No key saved yet.{/if}
          </small>
        </div>

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
              {#each mcpServers as server, serverIndex (serverIndex)}
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
                      <input id={`mcp-name-${serverIndex}`} class="input" bind:value={server.serverName} placeholder="duckduckgo" autocomplete="off" />
                      <small>Used in tool names such as <code>mcp__duckduckgo__search</code>.</small>
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
                      <input id={`mcp-command-${serverIndex}`} class="input" bind:value={server.command} placeholder="docker" autocomplete="off" />
                      <small>DSH starts this command when the runtime starts. Docker Desktop must be running.</small>
                    </div>

                    <div class="field" role="group">
                      <label for={`mcp-args-${serverIndex}`}>Arguments</label>
                      <textarea id={`mcp-args-${serverIndex}`} class="textarea mcp-args" bind:value={server.argsText} placeholder={'run\n-i\n--rm\nmcp/duckduckgo'} rows="4"></textarea>
                      <small>One argument per line. The Docker MCP server needs <code>-i</code> for stdio.</small>
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
          <button class="btn clear-key" data-variant="ghost" type="button" onclick={clearStoredKey} disabled={!settings?.apiKeyConfigured && !apiKey}>
            <Trash2 size={13} strokeWidth={1.8} /> Clear key
          </button>
          <button class="btn save-settings" type="submit" disabled={settingsRestarting}>
            {#if settingsRestarting}<LoaderCircle class="spin" size={13} strokeWidth={1.8} /> Applying…{:else}Save settings <Check size={13} strokeWidth={1.8} />{/if}
          </button>
        </div>
      </form>
      <p class:success={settingsStatusTone === 'success'} class:warning={settingsStatusTone === 'warning'} class="settings-status" role="status">{settingsStatus}</p>
    </section>
  {:else}
    <section class="chat-view">
      <div class="transcript" bind:this={transcriptElement} aria-live="polite">
        {#each messages as message (message.id)}
          <article class="message" class:user={message.role === 'user'} class:assistant={message.role === 'assistant'} class:reasoning={message.role === 'reasoning'} class:activity={message.role === 'activity'} class:tool={message.role === 'tool'}>
            {#if message.role === 'reasoning'}
              <details class="thinking">
                <summary><span>{message.label}</span><ChevronDown class="thinking-chevron" size={13} strokeWidth={1.8} /></summary>
                <div class="message-body">{message.text}</div>
              </details>
            {:else if message.role === 'tool' && message.tool}
              <details open={message.tool.approval?.status === 'pending'} class:completed={message.tool.status === 'completed'} class:failed={message.tool.status === 'error'} class="tool-details">
                <summary>
                  <Wrench size={13} strokeWidth={1.7} />
                  <span class="tool-name">{message.tool.name}</span>
                  <ArrowRight class="tool-flow-arrow" size={12} strokeWidth={1.7} />
                  <span class:error={message.tool.status === 'error' || message.tool.approval?.status === 'rejected'} class:running={message.tool.status === 'running' && message.tool.approval?.status === undefined} class="tool-status">{toolStatusLabel(message.tool)}</span>
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
                  <div class="tool-section">
                    <div class="tool-section-label">Arguments</div>
                    <pre class="tool-payload">{formatToolArguments(message.tool.arguments)}</pre>
                  </div>
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
            {:else}
              {#if message.role === 'user' && message.context}
                <div class="message-context" title={`${message.context.fileLabel} · ${selectionLineLabel(message.context)}`}>
                  <Code2 size={12} strokeWidth={1.7} />
                  <span class="message-context-file">{message.context.fileLabel}</span>
                  <span class="message-context-lines">{selectionLineLabel(message.context)}</span>
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
        {#if codeChanges.length > 0 && !isGenerating}
          <section class="changes-summary-card" aria-label="Agent changes summary">
            <div class="changes-summary-header">
              <span class="changes-title"><FileDiff size={13} strokeWidth={1.8} /> <span>Changes</span><span class="changes-count">{codeChanges.length}</span></span>
              <span class="changes-summary">{changeSummaryLabel()}</span>
            </div>
            <div class="changes-list changes-summary-list">
              {@render changeRows()}
            </div>
          </section>
        {/if}
      </div>

      <div class="composer">
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
              <span class="changes-summary">{changesActive ? 'Updating…' : changeSummaryLabel()}</span>
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
        <div class="composer-box">
          <textarea bind:this={promptElement} class="textarea" bind:value={prompt} onkeydown={handlePromptKeydown} placeholder="Ask about your code..." aria-label="Prompt" rows="2"></textarea>
          <div class="composer-footer">
            <div
              class="select sandbox-picker"
              bind:this={sandboxPickerElement}
              data-placeholder="Sandbox permissions"
              onchange={handleSandboxModeChange}
            >
              <button
                id="sandbox-picker-trigger"
                class="btn icon-button"
                data-variant="ghost"
                data-size="icon"
                type="button"
                aria-haspopup="listbox"
                aria-expanded="false"
                aria-controls="sandbox-picker-listbox"
                aria-label="Sandbox permissions"
                title={sandboxModeLabel()}
              >
                <span class="sandbox-picker-label">{sandboxModeLabel()}</span>
                {#if sandboxMode === 'read-only'}
                  <Eye size={14} strokeWidth={1.8} aria-hidden="true" />
                {:else if sandboxMode === 'workspace-write'}
                  <FolderPen size={14} strokeWidth={1.8} aria-hidden="true" />
                {:else}
                  <ShieldAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                {/if}
              </button>
              <div
                id="sandbox-picker-popover"
                data-popover
                data-side="top"
                data-align="start"
                aria-hidden="true"
              >
                <div
                  id="sandbox-picker-listbox"
                  class="sandbox-picker-listbox"
                  role="listbox"
                  aria-orientation="vertical"
                  aria-labelledby="sandbox-picker-trigger"
                >
                  <div role="option" data-value="read-only" aria-selected={sandboxMode === 'read-only' ? 'true' : undefined}>
                    <span>Read-only</span>
                  </div>
                  <div role="option" data-value="workspace-write" aria-selected={sandboxMode === 'workspace-write' ? 'true' : undefined}>
                    <span>Workspace write</span>
                  </div>
                  <div role="option" data-value="danger-full-access" aria-selected={sandboxMode === 'danger-full-access' ? 'true' : undefined}>
                    <span>Danger full access</span>
                  </div>
                </div>
              </div>
              <input type="hidden" name="sandbox-mode" value={sandboxMode} />
            </div>
            <div class="model-picker-wrap">
              <div
                bind:this={modelPickerElement}
                class="select model-picker"
                data-placeholder="Select model"
                onchange={handleModelChange}
              >
                <button
                  id="model-picker-trigger"
                  class="btn"
                  data-variant="ghost"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded="false"
                  aria-controls="model-picker-listbox"
                  aria-label="Model"
                  title={modelPickerLabel()}
                  disabled={modelsLoading || modelChanging}
                >
                  <span>{selectedModelLabel()}</span>
                  <ChevronDown size={13} strokeWidth={1.7} />
                </button>
                <div
                  id="model-picker-popover"
                  data-popover
                  data-side="top"
                  data-align="end"
                  aria-hidden="true"
                >
                  <div
                    id="model-picker-listbox"
                    class="model-picker-listbox"
                    role="listbox"
                    aria-orientation="vertical"
                    aria-labelledby="model-picker-trigger"
                  >
                    {#if models.length === 0}
                      <div class="model-picker-status" role="status">
                        {modelsLoading ? 'Loading models…' : modelsError || 'No models found'}
                      </div>
                    {:else}
                      {#if model && !models.some((option) => option.id === model)}
                        <div role="option" data-value={model} aria-selected="true">{model}</div>
                      {/if}
                      {#each models as option (option.id)}
                        <div role="option" data-value={option.id} aria-selected={model === option.id ? 'true' : undefined}>
                          {modelOptionLabel(option)}
                        </div>
                      {/each}
                    {/if}
                  </div>
                </div>
                <input type="hidden" name="model" value={model} />
              </div>
              <button class="btn model-refresh" data-variant="ghost" data-size="icon" type="button" aria-label="Refresh models" title="Refresh models" onclick={refreshModels} disabled={modelsLoading || modelChanging}>
                {#if modelsLoading}<LoaderCircle class="spin" size={13} strokeWidth={1.8} />{:else}<RefreshCw size={13} strokeWidth={1.8} />{/if}
              </button>
            </div>
            <div
              class="context-meter"
              role="img"
              aria-label={contextMeterLabel()}
              data-tooltip={contextMeterLabel()}
              data-side="top"
            >
              <span class="context-meter-ring" style={`--context-progress: ${contextProgress()}%`}>
              </span>
            </div>
            <button class="btn send" data-size="icon-sm" type="button" aria-label={isGenerating ? 'Stop generation' : 'Send message'} title={isGenerating ? 'Stop generation' : 'Send message'} onclick={submit} disabled={!isGenerating && !prompt.trim()}>
              {#if isGenerating}<Square size={13} strokeWidth={1.8} />{:else}<Send size={14} strokeWidth={1.8} />{/if}
            </button>
          </div>
        </div>
        <div class="session-id">session {activeSessionId || 'waiting for runtime'}</div>
      </div>
    </section>
  {/if}
</main>
