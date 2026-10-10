import { SkillController } from './host/skill-controller.js'
import * as vscode from 'vscode'
import { WorkspaceChangeTracker } from './runtime/change-tracker.js'
import { captureEditorContext, editorContextMetadata } from './runtime/editor-context.js'
import { HarnessRuntime } from './runtime/harness-runtime.js'
import type { RuntimeState } from './runtime/types.js'
import { SidebarProvider, type SidebarMessage, type SidebarState } from './sidebar/sidebar-provider.js'
import { SessionController } from './host/session-controller.js'
import { SettingsController } from './host/settings-controller.js'
import { RequestPreviewCancelledError, RequestPreviewController } from './host/request-preview-controller.js'
import { BrowserContextController } from './host/browser-context-controller.js'

type SidebarHandler = (message: SidebarMessage) => Promise<void>

class ExtensionApp {
  readonly sidebar: SidebarProvider
  private readonly runtime: HarnessRuntime
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly changeTracker: WorkspaceChangeTracker
  private readonly settings: SettingsController
  private readonly skills: SkillController
  private submissionGeneration = 0
  private readonly requestPreview: RequestPreviewController
  private readonly session: SessionController
  private readonly browserContext: BrowserContextController
  private submitting = false
  private generating = false
  private readonly messageHandlers: Record<SidebarMessage['type'], SidebarHandler>
  private readonly outputChannel: vscode.OutputChannel
  private readonly skillOutputChannel: vscode.OutputChannel
  private runtimeState: RuntimeState = 'stopped'
  private selection: SidebarState['selection']
  private routingMetadata = ''
  private disposed = false

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Helix Provider Requests')
    this.subscriptions.push(this.outputChannel)
    this.skillOutputChannel = vscode.window.createOutputChannel('Helix Skill Selection')
    this.subscriptions.push(this.skillOutputChannel)
    this.sidebar = new SidebarProvider(
      context.extensionUri,
      () => this.getSidebarState(),
      (message) => this.handleMessage(message),
      context.extensionMode === vscode.ExtensionMode.Development,
    )
    this.changeTracker = new WorkspaceChangeTracker(
      vscode.workspace.workspaceFolders?.[0]?.uri,
      (update) => this.sidebar.post({ type: 'codeChanges', ...update }),
    )
    this.subscriptions.push(this.changeTracker)

    this.runtime = new HarnessRuntime({
      onHandlerError: (error) => this.postError(error),
      onControlEvent: (event) => {
        if (event.method === 'provider.requestCaptured') {
          this.handleProviderRequestCaptured(event.params)
          return
        }
        if (event.method === 'skills.changed') { this.skills?.invalidate(); this.sidebar.post({ type: 'skillsInvalidated' }); void this.loadSkills(); return }
        this.session.handleControlEvent(event)
      },
      onLifecycleError: (error) => this.postError(error),
    })
    this.settings = new SettingsController({
      context,
      runtime: this.runtime,
      sidebar: this.sidebar,
      getRuntimeState: () => this.runtimeState,
      getActiveSessionId: () => this.session.currentSessionId,
      onError: (error) => this.postError(error),
    })
    this.skills = new SkillController({
      currentSession: () => this.session.currentSessionId,
      catalog: async (sessionId) => {
        if (this.runtimeState !== 'ready') await this.runtime.start(await this.settings.runtimeOptions())
        return this.runtime.skillCatalog(sessionId)
      },
      connection: () => this.settings.decisionConnection(),
      metadata: () => JSON.stringify({ workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? '', language: vscode.window.activeTextEditor?.document.languageId ?? '' }),
      publish: (suggestions) => this.sidebar.post({ type: 'skillSuggestions', suggestions }),
      publishCatalog: (sessionId, catalog) => this.sidebar.post({ type: 'skillCatalog', sessionId, catalog }),
      diagnostic: (event) => this.skillOutputChannel.appendLine(JSON.stringify(event)),
    })
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('deepseekHarness')) { this.skills.invalidate(); this.sidebar.post({ type: 'skillsInvalidated' }) }
      if (event.affectsConfiguration('deepseekHarness.experimentalSkillPicker')) {
        void this.settings.postSettings()
        if (!this.settings.skillPickerEnabled() && this.runtimeState === 'ready') {
          void this.runtime.clearSkills(this.session.currentSessionId).catch(() => undefined)
        }
      }
    }))
    this.requestPreview = new RequestPreviewController({
      getRuntimeOptions: () => this.settings.runtimeOptions(),
      resolveReasoningEffort: () => this.settings.resolveReasoningEffort(null),
      prepareSkills: async (runtime, sessionId, prompt) => {
        if (!this.settings.skillPickerEnabled()) return undefined
        const router = new SkillController({ currentSession: () => sessionId,
          catalog: (id) => runtime.skillCatalog ? runtime.skillCatalog(id) : Promise.reject(new Error('Skill discovery is unavailable.')),
          connection: () => this.settings.decisionConnection(), metadata: () => vscode.workspace.workspaceFolders?.[0]?.name ?? '',
          publish: () => undefined, publishCatalog: () => undefined })
        try {
          const selection = await router.freeze({ sessionId, revision: 0, prompt, recentChat: [] }, { include: [], exclude: [] })
          return this.settings.skillPickerEnabled() ? selection : undefined
        }
        finally { router.invalidate() }
      },
    })
    this.session = new SessionController({
      runtime: this.runtime,
      sidebar: this.sidebar,
      changeTracker: this.changeTracker,
      getRuntimeState: () => this.runtimeState,
      getRuntimeOptions: () => this.settings.runtimeOptions(),
      getEditorContext: (includeSelection) => captureEditorContext(includeSelection ? vscode.window.activeTextEditor : undefined),
      getMaxSelectionCharacters: () => vscode.workspace
        .getConfiguration('deepseekHarness')
        .get<number>('maxSelectionCharacters', 32_000),
      getSelectedModelId: () => vscode.workspace.getConfiguration('deepseekHarness').get<string>('model', 'deepseek-v4-flash'),
      resolveReasoningEffort: (selection, modelId) => this.settings.resolveReasoningEffort(selection, modelId),
      rememberReasoningEffort: async (modelId, effort) => {
        try {
          await this.settings.rememberReasoningEffort(modelId, effort)
        } catch (error) {
          void vscode.window.showWarningMessage(`Could not remember the reasoning effort: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      onError: (error) => this.postError(error),
      onStateChanged: (resetTranscript) => {
        if (resetTranscript) {
          this.generating = false
          this.browserContext?.reset(this.session.currentSessionId)
        }
        this.selection = editorSelection()
        this.sidebar.post({ type: 'state', state: this.getSidebarState(), resetTranscript })
      },
      onRunStatus: (running) => { this.generating = running },
    })

    this.browserContext = new BrowserContextController({
      sessionId: () => this.session.currentSessionId,
      maxCharacters: () => vscode.workspace.getConfiguration('deepseekHarness').get<number>('maxBrowserContextCharacters', 32_000),
      busy: () => this.submitting || this.generating,
      onState: (state) => this.sidebar.post({ type: 'browserContext', state }),
    })

    this.subscriptions.push(this.runtime.onStateChange(({ state, message }) => {
      this.runtimeState = state
      if (state === 'stopped' || state === 'error') {
        this.skills.invalidate()
        this.generating = false
        this.session.clearPendingQuestions(state === 'error' ? 'unavailable' : 'cancelled')
      }
      if (state === 'ready') { this.skills.invalidate(); this.sidebar.post({ type: 'skillsInvalidated' }) }
      this.sidebar.post({ type: 'state', state: this.getSidebarState() })
      if (message !== undefined) this.sidebar.post({ type: 'error', message })
    }))

    this.messageHandlers = {
      loadSkills: async (message) => { await this.loadSkills((message as Extract<SidebarMessage, { type: 'loadSkills' }>).sessionId) },
      analyzeSkills: async (message) => { if (this.settings.skillPickerEnabled()) this.skills.update((message as Extract<SidebarMessage, { type: 'analyzeSkills' }>).draft) },
      ready: () => this.handleReady(),
      openSettings: () => this.handleOpenSettings(),
      saveSettings: (message) => this.settings.run(() => this.settings.saveSettings(message as Extract<SidebarMessage, { type: 'saveSettings' }>)),
      saveMcpServers: (message) => this.settings.run(() => this.settings.saveMcpServers(message as Extract<SidebarMessage, { type: 'saveMcpServers' }>)),
      refreshModels: () => this.settings.run(() => this.settings.fetchModels()),
      loadModelCatalog: () => this.settings.run(() => this.settings.loadModelCatalog()),
      saveModelCatalog: (message) => this.settings.run(() => this.settings.saveModelCatalog(message as Extract<SidebarMessage, { type: 'saveModelCatalog' }>)),
      selectModel: (message) => this.settings.run(async () => {
        const selected = await this.settings.selectModel(message as Extract<SidebarMessage, { type: 'selectModel' }>)
        if (!selected) return
        this.session.resetReasoningEffort()
        this.sidebar.post({ type: 'state', state: this.getSidebarState() })
      }),
      setSandboxMode: (message) => this.settings.run(() => this.settings.setSandboxMode(message as Extract<SidebarMessage, { type: 'setSandboxMode' }>)),
      toggleBrowserPicker: () => this.browserContext.toggle(),
      removeBrowserAttachment: async (message) => {
        const remove = message as Extract<SidebarMessage, { type: 'removeBrowserAttachment' }>
        this.browserContext.remove(remove.sessionId, remove.id)
      },
      submit: (message) => {
        const submit = message as Extract<SidebarMessage, { type: 'submit' }>
        return this.settings.run(() => this.submitPrompt(submit))
      },
      cancelTurn: async () => { ++this.submissionGeneration; this.skills.cancel(); this.generating = false; await this.session.cancelTurn() },
      previewRequest: (message) => this.handleRequestPreview(message as Extract<SidebarMessage, { type: 'previewRequest' }>),
      cancelRequestPreview: () => this.requestPreview.cancel(),
      approvalDecision: (message) => this.session.resolveApproval(message as Extract<SidebarMessage, { type: 'approvalDecision' }>),
      questionAnswer: (message) => this.session.answerQuestion(message as Extract<SidebarMessage, { type: 'questionAnswer' }>),
      newSession: () => this.newSession(),
    }
  }

  refreshSelection(): void {
    const metadata = JSON.stringify([vscode.workspace.workspaceFolders?.[0]?.name, vscode.window.activeTextEditor?.document.languageId])
    if (metadata !== this.routingMetadata) {
      this.routingMetadata = metadata
      this.skills.invalidate()
      this.sidebar.post({ type: 'skillsInvalidated' })
    }
    this.selection = editorSelection()
    this.sidebar.post({ type: 'selection', selection: this.selection })
  }

  async newSession(): Promise<void> {
    ++this.submissionGeneration
    this.skills.invalidate()
    await this.browserContext.stop()
    await this.session.newSession()
  }

  toggleBrowserPicker(): Promise<void> { return this.browserContext.toggle() }

  private async submitPrompt(submit: Extract<SidebarMessage, { type: 'submit' }>): Promise<void> {
    const sessionId = this.session.currentSessionId
    const ids = submit.browserAttachmentIds ?? []
    if (submit.sessionId && submit.sessionId !== sessionId) return
    if (this.session.questions.length > 0) return
    if (this.submitting) return
    this.submitting = true
    const generation = ++this.submissionGeneration
    try {
      if (this.runtimeState !== 'ready') await this.runtime.start(await this.settings.runtimeOptions())
      const selectedSkills = this.settings.skillPickerEnabled() && submit.skillDraft
        ? await this.skills.freeze(submit.skillDraft, submit.skillOverrides ?? { include: [], exclude: [] }) : undefined
      if (generation !== this.submissionGeneration || sessionId !== this.session.currentSessionId) {
        this.sidebar.post({ type: 'submitFailed', sessionId, message: 'Submission cancelled.' })
        return
      }
      const snapshots = this.browserContext.snapshot(sessionId, ids)
      await this.browserContext.stop()
      const accepted = await this.session.submit(submit.prompt, submit.includeSelection, submit.reasoningEffort ?? null, snapshots,
        vscode.workspace.getConfiguration('deepseekHarness').get<number>('maxBrowserContextCharacters', 32_000), this.settings.skillPickerEnabled() ? selectedSkills : undefined)
      if (!accepted) this.sidebar.post({ type: 'submitFailed', sessionId, message: 'The message could not be submitted. Your draft and skill choices were retained.' })
      if (accepted && sessionId === this.session.currentSessionId) {
        this.skills.cancel()
        this.generating = true
        this.browserContext.consume(sessionId, ids)
      }
    } catch (error) {
      this.sidebar.post({ type: 'submitFailed', sessionId, message: error instanceof Error ? error.message : String(error) })
    } finally { this.submitting = false; this.skills.cancel() }
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.skills.invalidate()
    await this.browserContext.dispose()
    await this.session.dispose()
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
    this.sidebar.dispose()
    await this.runtime.dispose()
  }

  private async handleMessage(message: SidebarMessage): Promise<void> {
    await this.messageHandlers[message.type](message)
  }

  private async handleReady(): Promise<void> {
    this.refreshSelection()
    this.session.replayPendingApprovals()
    this.session.replayPendingQuestions()
    await this.settings.postSettings()
  }

  private async loadSkills(sessionId = this.session.currentSessionId): Promise<void> {
    if (!this.settings.skillPickerEnabled() || sessionId !== this.session.currentSessionId || this.disposed) return
    try { await this.skills.loadCatalog(sessionId) }
    catch (error) {
      this.sidebar.post({ type: 'skillCatalog', sessionId, catalog: { skills: [], revision: '', complete: false }, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async handleOpenSettings(): Promise<void> {
    await this.settings.postSettings()
  }

  private async handleRequestPreview(message: Extract<SidebarMessage, { type: 'previewRequest' }>): Promise<void> {
    this.sidebar.post({ type: 'requestPreviewState', state: 'loading' })
    try {
      const preview = await this.requestPreview.run(message.prompt)
      this.sidebar.post({ type: 'requestPreviewState', state: 'success', preview })
    } catch (error) {
      this.sidebar.post({
        type: 'requestPreviewState',
        state: error instanceof RequestPreviewCancelledError ? 'cancelled' : 'error',
        ...(error instanceof RequestPreviewCancelledError ? {} : { message: error instanceof Error ? error.message : String(error) }),
      })
    }
  }

  async captureNextProviderRequest(): Promise<void> {
    if (this.runtimeState !== 'ready') {
      void vscode.window.showErrorMessage('Start a chat before arming provider request capture.')
      return
    }
    try {
      this.outputChannel.clear()
      this.outputChannel.appendLine('Waiting for the next OpenAI Chat Completions request. Send one message in Helix.')
      this.outputChannel.appendLine('The capture includes prompt and workspace context. Authorization headers are not captured.')
      this.outputChannel.show(true)
      await this.runtime.captureNextProviderRequest(this.session.currentSessionId)
    } catch (error) {
      this.outputChannel.appendLine(`Could not arm capture: ${error instanceof Error ? error.message : String(error)}`)
      this.outputChannel.show(true)
    }
  }

  private handleProviderRequestCaptured(params: Record<string, unknown>): void {
    const url = typeof params.url === 'string' ? params.url : '(unknown URL)'
    this.outputChannel.appendLine(`Captured provider request: POST ${url}`)
    if (typeof params.body !== 'string') {
      this.outputChannel.appendLine('The request body was not available as text.')
      return
    }
    try {
      this.outputChannel.appendLine(JSON.stringify(JSON.parse(params.body), null, 2))
    } catch {
      this.outputChannel.appendLine(params.body)
    }
    this.outputChannel.show(true)
  }

  private getSidebarState(): SidebarState {
    const manifest = this.context.extension.packageJSON
    return {
      extensionInfo: {
        name: manifest.displayName ?? manifest.name,
        version: manifest.version,
        vscodeVersion: vscode.version,
        license: manifest.license,
      },
      activeSessionId: this.session.currentSessionId,
      runtimeState: this.runtimeState,
      reasoningEffort: this.session.currentReasoningEffort,
      selection: this.selection,
      browserContext: this.browserContext?.state,
      pendingQuestions: this.session.questions,
    }
  }

  private postError(error: unknown): void {
    this.generating = false
    this.sidebar.post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function editorSelection(): SidebarState['selection'] {
  return editorContextMetadata(vscode.window.activeTextEditor)
}

let activeApp: ExtensionApp | undefined

export function activate(context: vscode.ExtensionContext): void {
  const app = new ExtensionApp(context)
  activeApp = app
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dsh.sidebar', app.sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh.openSidebar', () => vscode.commands.executeCommand('workbench.view.extension.dsh')),
    vscode.commands.registerCommand('dsh.newSession', () => app.newSession()),
    vscode.commands.registerCommand('dsh.selectBrowserElements', async () => {
      await vscode.commands.executeCommand('dsh.openSidebar')
      await app.toggleBrowserPicker()
    }),
    vscode.commands.registerCommand('dsh.captureNextProviderRequest', () => app.captureNextProviderRequest()),
    vscode.commands.registerCommand('dsh.askSelection', async () => {
      await vscode.commands.executeCommand('dsh.openSidebar')
      app.refreshSelection()
    }),
    vscode.window.onDidChangeTextEditorSelection(() => app.refreshSelection()),
    vscode.window.onDidChangeActiveTextEditor(() => app.refreshSelection()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => app.refreshSelection()),
  )
}

export async function deactivate(): Promise<void> {
  const app = activeApp
  activeApp = undefined
  if (app !== undefined) await app.shutdown()
}
