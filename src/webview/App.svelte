<script lang="ts">
  import { onMount, tick } from 'svelte'
  import AboutSettings from './components/AboutSettings.svelte'
  import ConnectionSettings from './components/ConnectionSettings.svelte'
  import Masthead from './components/Masthead.svelte'
  import Transcript from './components/Transcript.svelte'
  import SettingsView from './components/SettingsView.svelte'
  import ModelsSettings from './components/ModelsSettings.svelte'
  import McpSettings from './components/McpSettings.svelte'
  import ToolsSettings from './components/ToolsSettings.svelte'
  import RequestPreviewPanel from './components/RequestPreviewPanel.svelte'
  import Composer from './components/Composer.svelte'
  import { ChatTranscript } from './lib/chat-transcript.svelte.js'
  import { SettingsPageState } from './lib/settings-page.svelte.js'
  import { ModelCatalogState } from './lib/model-catalog.svelte.js'
  import { ComposerModelState } from './lib/composer-model.svelte.js'
  import { SkillRoutingState } from './lib/skill-routing.svelte.js'
  import { ComposerCommandState } from './lib/composer-commands.svelte.js'
  import { RequestPreviewState } from './lib/request-preview.svelte.js'
  import { ToolBundlesState } from './lib/tool-bundles-state.svelte.js'
  import { SessionState } from './lib/session-state.svelte.js'
  import { createMessageRouter } from './lib/message-router.svelte.js'
  import { validateQuestionAnswer, type UserQuestionAnswer, type UserQuestionView } from '../shared/user-question.js'
  import type { GenUiAction } from '../shared/gen-ui.js'
  import type { CommandInvocation } from '../shared/commands.js'
  import { modelOptionLabel } from './lib/model-mappers.js'
  import type {
    ChatMessage,
    ToolCallView,
    IncomingMessage,
    SidebarMessage,
    SettingsPage,
    WebviewApi,
  } from './types.js'

  interface Props {
    vscode: WebviewApi
  }

  let { vscode }: Props = $props()

  const session = new SessionState()
  const transcript = new ChatTranscript(() => { session.waitingForFirstResponse = false })
  const settingsState = new SettingsPageState()
  const catalog = new ModelCatalogState()
  const composerModel = new ComposerModelState((modelId) => catalog.find(modelId))
  const preview = new RequestPreviewState((message) => post(message))
  const tools = new ToolBundlesState()
  const routing = new SkillRoutingState(
    (message) => post(message),
    () => ({
      enabled: session.skillPickerEnabled,
      sessionId: session.activeSessionId,
      isGenerating: session.isGenerating,
      hasPendingSubmission: session.hasPendingSubmission,
      prompt: session.prompt,
      decisions: session.settings?.decisions,
      languageId: session.selection?.languageId,
    }),
    () => transcript.chatTurns(),
  )
  routing.start()
  routing.watch()
  const commands = new ComposerCommandState((message) => post(message), () => session.activeSessionId)
  commands.start()
  const handleMessage = createMessageRouter({ post, state: session, transcript, settingsState, catalog, composerModel, routing, preview, tools, commands })
  let composer = $state<{ focus: () => void }>()
  const skillPickerEnabled = $derived(session.skillPickerEnabled)

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
    // VS Code's transport cannot clone Svelte's nested session proxies.
    vscode.postMessage($state.snapshot(message))
  }

  function submit(): void {
    if (session.isGenerating || transcript.waitingForAnswer) {
      transcript.finishThinking()
      transcript.interruptCompaction()
      session.waitingForFirstResponse = false
      routing.resetForTurn()
      post({ type: 'cancelTurn' })
      return
    }

    const text = session.prompt.trim()
    if (!text) return

    const invocation = commands.invocation(text)
    if (invocation !== undefined) {
      runCommand(invocation)
      return
    }

    if (session.codeChanges.length > 0) {
      transcript.appendChanges(session.codeChanges, session.changesOpen)
      session.codeChanges = []
      session.changesOpen = false
    }

    const routingDraft = routing.draft(session.activeSessionId, text)
    const attachedSelection = session.selectionAttached ? session.selection : undefined
    const browserAttachments = session.browserContext?.attachments ?? []
    const userId = transcript.appendMessage('user', 'You', text, attachedSelection, browserAttachments.map((attachment) => attachment.label))
    session.pendingSubmission = { text, userId }
    session.isGenerating = true
    session.waitingForFirstResponse = true
    post({
      type: 'submit',
      prompt: text,
      includeSelection: attachedSelection !== undefined,
      reasoningEffort: composerModel.reasoningEffort,
      sessionId: session.activeSessionId,
      browserAttachmentIds: browserAttachments.map((attachment) => attachment.id),
      ...(skillPickerEnabled ? { skillDraft: routingDraft,
        skillOverrides: { include: [...routing.overrides.include], exclude: [...routing.overrides.exclude] } } : {}),
    })
    session.selectionAttached = true
    void tick().then(() => composer?.focus())
  }

  /** A resolved slash command: the Host runs it, and what the user typed reads as a turn. */
  function runCommand(invocation: CommandInvocation): void {
    commands.close()
    session.prompt = ''
    transcript.appendCommand(invocation.name, invocation.args)
    post({ type: 'runCommand', sessionId: session.activeSessionId, name: invocation.name, args: invocation.args })
    void tick().then(() => composer?.focus())
  }

  function startNewSession(): void {
    session.waitingForFirstResponse = false
    post({ type: 'newSession' })
  }

  function refreshModels(): void {
    catalog.beginRefresh()
    post({ type: 'refreshModels' })
  }

  function handleComposerModelSelection(nextModel: string): void {
    if (!nextModel) return
    composerModel.select(nextModel)
    post({ type: 'selectModel', model: nextModel })
  }

  function handleAddDiscoveredModel(selectedId: string): void {
    if (!selectedId) return
    const result = catalog.addDiscovered(selectedId)
    if (result.outcome === 'exists') settingsState.setStatus(`Model "${result.label}" is already in the catalog.`, 'warning')
    if (result.outcome === 'added') settingsState.setStatus(`Added ${result.label}. Edit its details, then save models.`, 'success')
  }

  function saveModelCatalog(): void {
    catalog.beginSave()
    settingsState.setStatus('Saving models…', 'warning')
    try {
      post(catalog.buildSaveMessage())
    } catch (error) {
      catalog.saveRejected()
      settingsState.setStatus(error instanceof Error ? error.message : String(error), 'warning')
    }
  }

  function answerQuestion(question: UserQuestionView, value: UserQuestionAnswer): void {
    if (question.status !== 'pending') return
    try {
      const answer = validateQuestionAnswer(question.question, value)
      transcript.updateQuestion(question.requestId, { status: 'submitting', error: undefined })
      post({ type: 'questionAnswer', sessionId: session.activeSessionId, requestId: question.requestId, answer })
    } catch (error) { transcript.updateQuestion(question.requestId, { error: error instanceof Error ? error.message : String(error) }) }
  }

  function decideApproval(tool: ToolCallView, outcome: 'allowed-once' | 'rejected'): void {
    const requestId = transcript.markApprovalPending(tool)
    if (requestId !== undefined) post({ type: 'approvalDecision', sessionId: session.activeSessionId, requestId, outcome })
  }

  /**
   * What a card asks for. Dismiss and copy stay in the Webview. A prompt runs a
   * new turn, or joins the running one as an inject. Opening a file or a link
   * is the Host's decision: a card names an intent, Helix decides whether it is
   * allowed and by what path.
   */
  function handleUiAction(message: ChatMessage, action: GenUiAction): void {
    const callId = message.ui?.callId
    if (callId === undefined) return
    if (action.kind === 'dismiss') {
      transcript.updateUi(callId, { status: 'dismissed' })
      return
    }
    if (action.kind === 'copy') {
      void navigator.clipboard?.writeText(action.text)
      return
    }
    if (action.kind === 'prompt' && !session.isGenerating && !transcript.waitingForAnswer) {
      sendPromptFromCard(action.text)
      return
    }
    if (action.kind === 'prompt' || action.kind === 'inject') {
      post({ type: 'uiAction', sessionId: session.activeSessionId, callId, action: { kind: 'inject', text: action.text } })
      return
    }
    post({ type: 'uiAction', sessionId: session.activeSessionId, callId, action })
  }

  /** A card's prompt button, run as a normal turn: the user's line lands at once. */
  function sendPromptFromCard(text: string): void {
    transcript.finishThinking()
    transcript.interruptCompaction()
    routing.resetForTurn()
    session.waitingForFirstResponse = true
    const userId = transcript.appendMessage('user', 'You', text)
    session.pendingSubmission = { text, userId }
    session.isGenerating = true
    post({
      type: 'submit',
      prompt: text,
      includeSelection: false,
      reasoningEffort: composerModel.reasoningEffort,
      sessionId: session.activeSessionId,
    })
  }

  function openSettings(page: SettingsPage): void {
    if (settingsState.page !== undefined && settingsState.page !== page) resetSettingsPageDrafts(settingsState.page)
    settingsState.open(page)
    post({ type: 'openSettings' })
    if (page === 'models') {
      catalog.beginLoad()
      post({ type: 'loadModelCatalog' })
      post({ type: 'refreshModels' })
    }
    if (page === 'preview') preview.runNominal()
  }

  function resetSettingsPageDrafts(page: SettingsPage): void {
    settingsState.resetDrafts(page, session.settings)
    if (page === 'models') catalog.resetDrafts()
    if (page === 'tools') tools.reset()
  }

  function closeSettings(): void {
    if (settingsState.page !== undefined) resetSettingsPageDrafts(settingsState.page)
    settingsState.close()
  }

  function saveSettings(): void {
    settingsState.beginSave()
    try {
      post(settingsState.buildSaveMessage(skillPickerEnabled))
    } catch (error) {
      settingsState.saveRejected(error instanceof Error ? error.message : String(error))
    }
  }

  function saveMcpServers(): void {
    settingsState.beginMcpSave()
    post(settingsState.buildMcpMessage())
  }

  /** Saving tools is a plain settings write: the running session keeps its tools. */
  function saveTools(): void {
    tools.beginSave()
    settingsState.setStatus('Saving tools…', 'warning')
    try {
      post(tools.buildSaveMessage())
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      settingsState.setStatus(tools.saveRejected(reason), 'warning')
    }
  }

</script>

<main class="flex h-full min-h-full flex-col bg-[var(--background)]">
  <Masthead
    onNewSession={startNewSession}
    onOpenSettings={openSettings}
  />

  {#if settingsState.page}
    <SettingsView
      title={settingsState.title(settingsState.page)}
      status={settingsState.status}
      tone={settingsState.tone}
      onClose={closeSettings}
    >
      {#if settingsState.page === 'about'}
        <AboutSettings info={session.extensionInfo} />
      {:else if settingsState.page === 'connection'}
        <ConnectionSettings
          bind:provider={settingsState.provider}
          bind:baseUrl={settingsState.baseUrl}
          bind:apiKey={settingsState.apiKey}
          bind:clearApiKey={settingsState.clearApiKey}
          bind:sandboxMode={settingsState.sandboxMode}
          bind:tracing={settingsState.tracing}
          bind:decisions={settingsState.decisions}
          bind:decisionApiKey={settingsState.decisionsApiKey}
          bind:clearDecisionApiKey={settingsState.clearDecisionsApiKey}
          apiKeyConfigured={session.settings?.apiKeyConfigured ?? false}
          decisionKeyConfigured={session.settings?.decisions?.apiKeyConfigured ?? false}
          {skillPickerEnabled}
          settingsRestarting={settingsState.restarting}
          onSave={saveSettings}
          onStatus={(text, tone) => settingsState.setStatus(text, tone)}
        />
      {:else if settingsState.page === 'models'}
        <ModelsSettings
          bind:modelDrafts={catalog.drafts}
          discoveredModels={catalog.discovered}
          modelsLoading={catalog.loading}
          modelsError={catalog.error}
          modelCatalogLoading={catalog.catalogLoading}
          modelCatalogSaving={catalog.catalogSaving}
          modelCatalogError={catalog.catalogError}
          {modelOptionLabel}
          onAddModel={handleAddDiscoveredModel}
          onRefreshModels={refreshModels}
          onSaveModels={saveModelCatalog}
          onStatus={(text, tone) => settingsState.setStatus(text, tone)}
        />
      {:else if settingsState.page === 'tools'}
        <ToolsSettings
          bind:disabled={tools.disabled}
          saved={tools.saved}
          saving={tools.saving}
          onSave={saveTools}
          onDiscard={() => tools.reset()}
        />
      {:else if settingsState.page === 'mcp'}
        <McpSettings
          bind:mcpServers={settingsState.mcpServers}
          mcpSaving={settingsState.mcpSaving}
          settingsRestarting={settingsState.restarting}
          onSave={saveMcpServers}
        />
      {:else}
        <RequestPreviewPanel
          bind:showRawJson={preview.showRawJson}
          state={preview.status}
          preview={preview.result}
          error={preview.error}
          onCancel={() => preview.cancel()}
        />
      {/if}
    </SettingsView>
  {:else}
    <section class="flex flex-1 min-h-0 flex-col">
      <Transcript
        {transcript}
        activeSessionId={session.activeSessionId}
        isGenerating={session.isGenerating}
        waitingForFirstResponse={session.waitingForFirstResponse}
        codeChanges={session.codeChanges}
        bind:changesOpen={session.changesOpen}
        onanswer={(message, answer) => answerQuestion(message.tool!.question!, answer)}
        onapprove={(message, outcome) => decideApproval(message.tool!, outcome)}
        onui={handleUiAction}
      />

      <Composer
        bind:this={composer}
        bind:prompt={session.prompt}
        bind:selectionAttached={session.selectionAttached}
        bind:changesOpen={session.changesOpen}
        bind:skillOverrides={routing.overrides}
        isGenerating={session.isGenerating}
        waitingForAnswer={transcript.waitingForAnswer}
        submissionPending={Boolean(session.pendingSubmission)}
        selection={session.selection}
        browserContext={session.browserContext}
        codeChanges={session.codeChanges}
        models={catalog.models}
        model={composerModel.model}
        reasoningEffort={composerModel.reasoningEffort}
        modelChanging={composerModel.changing}
        contextUsedTokens={composerModel.contextUsed}
        contextWindowTokens={composerModel.contextWindow}
        {skillPickerEnabled}
        skills={routing.catalog.skills}
        skillSuggestions={routing.suggestions}
        skillError={routing.error}
        {commands}
        {modelOptionLabel}
        onSubmit={submit}
        onModelSelect={handleComposerModelSelection}
        onReasoningEffortSelect={(value: string) => composerModel.selectEffort(value)}
        onRemoveBrowserAttachment={(id) => post({ type: 'removeBrowserAttachment', sessionId: session.activeSessionId, id })}
        onToggleBrowserPicker={() => post({ type: 'toggleBrowserPicker' })}
      />
    </section>
  {/if}
</main>
