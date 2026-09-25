import * as vscode from 'vscode'
import { WorkspaceChangeTracker } from './runtime/change-tracker.js'
import { editorContextMetadata } from './runtime/editor-context.js'
import { HarnessRuntime } from './runtime/harness-runtime.js'
import type { RuntimeState } from './runtime/types.js'
import { SidebarProvider, type SidebarMessage, type SidebarState } from './sidebar/sidebar-provider.js'
import { SessionController } from './host/session-controller.js'
import { SettingsController } from './host/settings-controller.js'

type SidebarHandler = (message: SidebarMessage) => Promise<void>

class ExtensionApp {
  readonly sidebar: SidebarProvider
  private readonly runtime: HarnessRuntime
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly changeTracker: WorkspaceChangeTracker
  private readonly settings: SettingsController
  private readonly session: SessionController
  private readonly messageHandlers: Record<SidebarMessage['type'], SidebarHandler>
  private runtimeState: RuntimeState = 'stopped'
  private selection: SidebarState['selection']
  private disposed = false

  constructor(private readonly context: vscode.ExtensionContext) {
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
      onControlEvent: (event) => this.session.handleControlEvent(event),
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
    this.session = new SessionController({
      runtime: this.runtime,
      sidebar: this.sidebar,
      changeTracker: this.changeTracker,
      getRuntimeState: () => this.runtimeState,
      getRuntimeOptions: () => this.settings.runtimeOptions(),
      getMaxSelectionCharacters: () => vscode.workspace
        .getConfiguration('deepseekHarness')
        .get<number>('maxSelectionCharacters', 32_000),
      onError: (error) => this.postError(error),
      onStateChanged: (resetTranscript) => {
        this.selection = editorSelection()
        this.sidebar.post({ type: 'state', state: this.getSidebarState(), resetTranscript })
      },
    })

    this.subscriptions.push(this.runtime.onStateChange(({ state, message }) => {
      this.runtimeState = state
      this.sidebar.post({ type: 'state', state: this.getSidebarState() })
      if (message !== undefined) this.sidebar.post({ type: 'error', message })
    }))

    this.messageHandlers = {
      ready: () => this.handleReady(),
      openSettings: () => this.handleOpenSettings(),
      saveSettings: (message) => this.settings.run(() => this.settings.saveSettings(message as Extract<SidebarMessage, { type: 'saveSettings' }>)),
      refreshModels: () => this.settings.run(() => this.settings.fetchModels()),
      selectModel: (message) => this.settings.run(() => this.settings.selectModel(message as Extract<SidebarMessage, { type: 'selectModel' }>)),
      setSandboxMode: (message) => this.settings.run(() => this.settings.setSandboxMode(message as Extract<SidebarMessage, { type: 'setSandboxMode' }>)),
      submit: (message) => {
        const submit = message as Extract<SidebarMessage, { type: 'submit' }>
        return this.session.submit(submit.prompt, submit.includeSelection)
      },
      cancelTurn: () => this.session.cancelTurn(),
      approvalDecision: (message) => this.session.resolveApproval(message as Extract<SidebarMessage, { type: 'approvalDecision' }>),
      newSession: () => this.session.newSession(),
    }
  }

  refreshSelection(): void {
    this.selection = editorSelection()
    this.sidebar.post({ type: 'selection', selection: this.selection })
  }

  newSession(): Promise<void> {
    return this.session.newSession()
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
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
    await this.settings.postSettings()
    await this.settings.run(() => this.settings.fetchModels())
  }

  private async handleOpenSettings(): Promise<void> {
    await this.settings.postSettings()
    await this.settings.run(() => this.settings.fetchModels())
  }

  private getSidebarState(): SidebarState {
    return {
      activeSessionId: this.session.currentSessionId,
      runtimeState: this.runtimeState,
      selection: this.selection,
    }
  }

  private postError(error: unknown): void {
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
    vscode.commands.registerCommand('dsh.askSelection', async () => {
      await vscode.commands.executeCommand('dsh.openSidebar')
      app.refreshSelection()
    }),
    vscode.window.onDidChangeTextEditorSelection(() => app.refreshSelection()),
    vscode.window.onDidChangeActiveTextEditor(() => app.refreshSelection()),
  )
}

export async function deactivate(): Promise<void> {
  const app = activeApp
  activeApp = undefined
  if (app !== undefined) await app.shutdown()
}
