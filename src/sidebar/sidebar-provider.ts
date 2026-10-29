import * as vscode from 'vscode'
import { isRecord } from '../shared/value-utils.js'
import { getHtml } from './sidebar-html.js'
import {
  isSidebarMessage,
  type SidebarMessage,
  type SidebarOutgoingMessage,
  type SidebarState,
} from './sidebar-protocol.js'

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private readonly watcherDisposables: vscode.Disposable[] = []
  private reloadTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getState: () => SidebarState,
    private readonly onMessage: (message: SidebarMessage) => void | Promise<void>,
    private readonly watchWebview = false,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'out', 'webview')
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    }
    webviewView.onDidDispose(() => {
      if (this.view !== webviewView) return
      this.view = undefined
      this.disposeWebviewWatcher()
    })
    if (this.watchWebview) this.watchWebviewOutput(webviewView, webviewRoot)
    webviewView.webview.html = getHtml(webviewView.webview, this.extensionUri)
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (!isSidebarMessage(message)) {
        if (isRecord(message) && (message.type === 'saveSettings' || message.type === 'saveMcpServers' || message.type === 'saveTools')) {
          this.post({
            type: 'error',
            message: 'Could not save settings. Reload the Extension Development Host and try again.',
          })
        }
        return
      }
      void Promise.resolve(this.onMessage(message)).catch((error: unknown) => {
        this.post({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
    })
    this.post({ type: 'state', state: this.getState(), resetTranscript: true })
  }

  post(message: SidebarOutgoingMessage): void {
    const view = this.view
    if (view === undefined) return
    void view.webview.postMessage(message).then(() => undefined, () => undefined)
  }

  dispose(): void {
    this.disposeWebviewWatcher()
  }

  private watchWebviewOutput(webviewView: vscode.WebviewView, webviewRoot: vscode.Uri): void {
    this.disposeWebviewWatcher()
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(webviewRoot, '**/*'))
    const reload = () => this.scheduleWebviewReload(webviewView)

    this.watcherDisposables.push(
      watcher,
      watcher.onDidCreate(reload),
      watcher.onDidChange(reload),
      watcher.onDidDelete(reload),
    )
  }

  private scheduleWebviewReload(webviewView: vscode.WebviewView): void {
    if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined
      if (this.view !== webviewView) return
      webviewView.webview.html = getHtml(webviewView.webview, this.extensionUri)
    }, 180)
  }

  private disposeWebviewWatcher(): void {
    if (this.reloadTimer !== undefined) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = undefined
    }
    for (const disposable of this.watcherDisposables.splice(0)) disposable.dispose()
  }
}

// The wire protocol (message types and their validators) and the webview
// bootstrap page moved to their own files; this path keeps re-exporting them
// so existing importers are unaffected.
export {
  type SidebarCodeChange,
  type SidebarDiscoveredModel,
  type SidebarMcpEnvironment,
  type SidebarMcpServer,
  type SidebarMcpServerSetting,
  type SidebarMcpTransport,
  type SidebarMessage,
  type SidebarModel,
  type SidebarSettings,
  type SidebarState,
  type SidebarOutgoingMessage,
  isModelDraft,
  isSandboxMode,
  isSidebarMcpServer,
  isSidebarMessage,
  isUiActionShape,
} from './sidebar-protocol.js'
