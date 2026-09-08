import { readFileSync } from 'node:fs'
import * as vscode from 'vscode'
import type { EditorContext } from '../runtime/prompt-context.js'
import type { RuntimeState } from '../runtime/types.js'
import type { DiscoveredModel } from '../runtime/model-catalog.js'

export type SidebarMessage =
  | { type: 'ready' }
  | { type: 'openSettings' }
  | {
      type: 'saveSettings'
      provider: string
      baseUrl: string
      apiKey?: string
      clearApiKey: boolean
      mcpServers: SidebarMcpServer[]
    }
  | { type: 'submit'; prompt: string; includeSelection: boolean }
  | { type: 'newSession' }
  | { type: 'refreshModels' }
  | { type: 'selectModel'; model: string; contextWindow?: number }

export interface SidebarState {
  activeSessionId: string
  runtimeState: RuntimeState
  selection?: Omit<EditorContext, 'ranges'> & {
    ranges: Array<Omit<EditorContext['ranges'][number], 'text'>>
  }
}

export interface SidebarSettings {
  provider: string
  model: string
  contextWindow: number
  baseUrl: string
  dshHome: string
  apiKeyConfigured: boolean
  mcpServers: SidebarMcpServerSetting[]
}

export type SidebarMcpTransport = 'stdio' | 'streamable-http'

export interface SidebarMcpEnvironment {
  name: string
  value?: string
  configured?: boolean
}

export interface SidebarMcpServer {
  serverName: string
  transport: SidebarMcpTransport
  command: string
  args: string[]
  url: string
  env: SidebarMcpEnvironment[]
}

export interface SidebarMcpServerSetting extends Omit<SidebarMcpServer, 'env'> {
  env: Array<{ name: string; configured: boolean }>
}

export type SidebarModel = DiscoveredModel

export type SidebarOutgoingMessage =
  | { type: 'state'; state: SidebarState; resetTranscript?: boolean }
  | { type: 'settings'; settings: SidebarSettings }
  | { type: 'settingsSaved'; settings: SidebarSettings; restarting: boolean }
  | { type: 'selection'; selection?: SidebarState['selection'] }
  | { type: 'notification'; sessionId: string; notification: unknown }
  | { type: 'error'; message: string }
  | { type: 'accepted'; sessionId: string }
  | { type: 'models'; models: SidebarModel[]; error?: string }

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
    if (this.watchWebview) this.watchWebviewOutput(webviewView, webviewRoot)
    webviewView.webview.html = getHtml(webviewView.webview, this.extensionUri)
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (!isSidebarMessage(message)) {
        if (isRecord(message) && message.type === 'saveSettings') {
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
    void this.view?.webview.postMessage(message)
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
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined
          this.disposeWebviewWatcher()
        }
      }),
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

function isSidebarMessage(value: unknown): value is SidebarMessage {
  if (!isRecord(value) || !('type' in value)) return false
  const type = value.type
  if (type === 'saveSettings') {
    return 'provider' in value && typeof value.provider === 'string' &&
      'baseUrl' in value && typeof value.baseUrl === 'string' &&
      'clearApiKey' in value && typeof value.clearApiKey === 'boolean' &&
      'mcpServers' in value && Array.isArray(value.mcpServers) && value.mcpServers.every(isSidebarMcpServer) &&
      (!('apiKey' in value) || typeof value.apiKey === 'string')
  }
  if (type === 'submit') {
    return 'prompt' in value && typeof value.prompt === 'string' &&
      'includeSelection' in value && typeof value.includeSelection === 'boolean'
  }
  if (type === 'selectModel') {
    return 'model' in value && typeof value.model === 'string' &&
      (!('contextWindow' in value) || value.contextWindow === undefined ||
        (typeof value.contextWindow === 'number' && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0))
  }

  return type === 'ready' ||
    type === 'openSettings' ||
    type === 'newSession' ||
    type === 'refreshModels'
}

function isSidebarMcpServer(value: unknown): value is SidebarMcpServer {
  if (!isRecord(value) || typeof value.serverName !== 'string' ||
    (value.transport !== 'stdio' && value.transport !== 'streamable-http') ||
    typeof value.command !== 'string' || typeof value.url !== 'string' ||
    !Array.isArray(value.args) || !value.args.every((argument) => typeof argument === 'string') ||
    !Array.isArray(value.env)) return false

  return value.env.every((entry) => isRecord(entry) && typeof entry.name === 'string' &&
    (!('value' in entry) || typeof entry.value === 'string') &&
    (!('configured' in entry) || typeof entry.configured === 'boolean'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce()
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource} data:`,
  ].join('; ')
  const htmlPath = vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'index.html').fsPath

  try {
    let html = readFileSync(htmlPath, 'utf8')
    const assetsRoot = vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'assets')

    html = html.replace(/(src|href)="\.\/assets\/([^"]+)"/g, (_match, attribute: string, asset: string) => {
      const assetUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, asset))
      return `${attribute}="${assetUri}"`
    })
    html = html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}" />`)
    html = html.replace(/<script(\s|>)/g, `<script nonce="${nonce}"$1`)
    return html
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>body { color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); padding: 16px; } code { color: var(--vscode-errorForeground); }</style>
</head>
<body>
  <strong>DeepSeek Harness UI is not built.</strong>
  <p>Run <code>npm run compile</code>, then reload the Extension Development Host.</p>
  <small>${escapeHtml(message)}</small>
</body>
</html>`
  }
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let value = ''
  for (let index = 0; index < 32; index += 1) value += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  return value
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character)
}
