import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import { BrowserCdpClient } from '../runtime/browser-cdp.js'
import { BrowserAttachments } from '../runtime/browser-attachments.js'
import { browserPickerExpression } from '../runtime/browser-picker-script.js'
import type { BrowserContextState, BrowserElementContext } from '../shared/browser-context.js'
import { isRecord } from '../shared/value-utils.js'

const SETUP_MESSAGE = 'Browser selection requires the browser proposed API. Enable "enable-proposed-api": ["local.helix-vscode"] in Preferences: Configure Runtime Arguments, then fully restart VS Code. This VS Code version must include the browser API.'

interface PickerRun {
  tab: vscode.BrowserTab
  client?: BrowserCdpClient
  targetSession?: string
  contexts: number[]
  binding: string
  cleanup: string
}

export class BrowserContextController {
  private readonly attachments: BrowserAttachments
  private readonly subscriptions: vscode.Disposable[] = []
  private run: PickerRun | undefined
  private lastTab: vscode.BrowserTab | undefined
  private readonly available: boolean
  private message: string | undefined
  private disposed = false

  constructor(private readonly options: {
    sessionId(): string
    maxCharacters(): number
    busy(): boolean
    onState(state: BrowserContextState): void
  }) {
    this.attachments = new BrowserAttachments(options.sessionId())
    try {
      this.available = Array.isArray(vscode.window.browserTabs) && typeof vscode.window.onDidChangeActiveBrowserTab === 'function'
      if (this.available) {
        this.lastTab = vscode.window.activeBrowserTab
        this.subscriptions.push(
          vscode.window.onDidOpenBrowserTab(() => this.publish()),
          vscode.window.onDidChangeActiveBrowserTab((tab) => {
            if (tab) this.lastTab = tab
            if (tab && this.run && tab !== this.run.tab) void this.stop()
          }),
          vscode.window.onDidCloseBrowserTab((tab) => {
            if (this.lastTab === tab) this.lastTab = undefined
            if (this.run?.tab === tab) void this.stop('The browser tab was closed.')
            else this.publish()
          }),
        )
      }
    } catch { this.available = false }
  }

  get state(): BrowserContextState {
    return { sessionId: this.attachments.sessionId, available: this.available,
      hasOpenBrowser: this.available && vscode.window.browserTabs.length > 0, picking: this.run !== undefined,
      attachments: this.attachments.list(this.limit), message: this.message }
  }
  private get limit(): number {
    const value = this.options.maxCharacters()
    return Number.isFinite(value) ? Math.max(1_000, Math.min(1_000_000, Math.floor(value))) : 32_000
  }
  private publish(): void { if (!this.disposed) this.options.onState(this.state) }
  report(message: string): void { this.message = message; this.publish() }
  remove(sessionId: string, id: string): void {
    if (sessionId !== this.attachments.sessionId) return
    this.attachments.remove(id)
    this.publish()
  }
  snapshot(sessionId: string, ids: readonly string[]): BrowserElementContext[] { return this.attachments.snapshot(sessionId, ids, this.limit) }
  consume(sessionId: string, ids: readonly string[]): void { this.attachments.consume(sessionId, ids); this.publish() }
  reset(sessionId: string): void {
    void this.stop()
    this.attachments.reset(sessionId)
    this.message = undefined
    this.publish()
  }

  async toggle(): Promise<void> {
    if (this.disposed) return
    if (this.run) { await this.stop(); return }
    if (!this.available) { this.report(SETUP_MESSAGE); void vscode.window.showInformationMessage(SETUP_MESSAGE); return }
    if (this.options.busy()) { this.report('Wait for the current response before selecting browser elements.'); return }
    const sessionId = this.options.sessionId()
    const tabs = vscode.window.browserTabs
    if (!tabs.length) { this.report('Open a page in the VS Code integrated browser, then select browser elements.'); return }
    let tab = vscode.window.activeBrowserTab ?? (this.lastTab && tabs.includes(this.lastTab) ? this.lastTab : undefined)
    if (!tab) {
      const selection = await vscode.window.showQuickPick(tabs.map((entry) => ({ label: entry.title || entry.url, description: entry.url, tab: entry })), { placeHolder: tabs.length ? 'Select a browser tab for Helix' : 'Open a page in the integrated browser first' })
      tab = selection?.tab
    }
    if (!tab || this.disposed || sessionId !== this.options.sessionId() || this.options.busy() || this.run) return
    await this.revealTab(tab)
    if (this.disposed || sessionId !== this.options.sessionId() || this.options.busy() || this.run) return
    if (vscode.window.activeBrowserTab !== tab) { this.report('Switch to the selected browser tab, then start the element picker again.'); return }
    this.lastTab = tab
    const token = randomUUID().replaceAll('-', '')
    const run: PickerRun = { tab, contexts: [], binding: `helixPick${token}`, cleanup: `helixStop${token}` }
    this.run = run
    this.message = 'Starting element selection…'
    this.publish()
    try {
      const transport = await tab.startCDPSession()
      if (this.run !== run) { await transport.close(); return }
      const client = run.client = new BrowserCdpClient(transport, (event) => this.onEvent(run, event), () => {
        if (this.run === run) void this.stop('Browser connection closed.')
      })
      const targets = await client.request('Target.getTargets')
      const target = Array.isArray(targets.targetInfos) ? targets.targetInfos.find((entry) => isRecord(entry) && entry.type === 'page') : undefined
      if (!isRecord(target) || typeof target.targetId !== 'string') throw new Error('Could not find the browser page target')
      const attached = await client.request('Target.attachToTarget', { targetId: target.targetId, flatten: true })
      if (typeof attached.sessionId !== 'string') throw new Error('Could not attach to the browser page')
      run.targetSession = attached.sessionId
      await client.request('Page.enable', {}, run.targetSession)
      await client.request('Runtime.enable', {}, run.targetSession)
      const result = await client.request('Page.getFrameTree', {}, run.targetSession)
      if (!isRecord(result.frameTree) || !isRecord(result.frameTree.frame)) throw new Error('Could not read the browser page frames')
      const pageUrl = String(result.frameTree.frame.url)
      let skippedFrames = 0
      const install = async (tree: Record<string, unknown>): Promise<void> => {
        if (this.run !== run || !isRecord(tree.frame)) return
        const frame = tree.frame
        let sameOrigin = tree === result.frameTree || frame.url === 'about:blank' || frame.url === 'about:srcdoc'
        try { sameOrigin ||= new URL(String(frame.url)).origin === new URL(pageUrl).origin } catch { /* Non-URL child frames are skipped. */ }
        if (sameOrigin && typeof frame.id === 'string') {
          const world = await client.request('Page.createIsolatedWorld', { frameId: frame.id, worldName: run.binding }, run.targetSession)
          if (typeof world.executionContextId !== 'number') throw new Error('Could not create a browser selection context')
          const contextId = world.executionContextId
          run.contexts.push(contextId)
          await client.request('Runtime.addBinding', { name: run.binding, executionContextId: contextId }, run.targetSession)
          const evaluated = await client.request('Runtime.evaluate', { expression: browserPickerExpression(run.binding, run.cleanup, this.limit), contextId }, run.targetSession)
          if (evaluated.exceptionDetails) throw new Error('Could not install the element picker on this page')
        } else skippedFrames++
        if (sameOrigin && Array.isArray(tree.childFrames)) for (const child of tree.childFrames) if (isRecord(child)) await install(child)
      }
      await install(result.frameTree)
      if (this.run !== run) return
      this.message = skippedFrames ? 'Cross-origin frames are not supported.' : undefined
      this.publish()
      // Restore browser focus after a composer button click or tab quick pick.
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
    } catch (error) {
      if (this.run === run) await this.stop(`Could not start browser selection: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async revealTab(tab: vscode.BrowserTab): Promise<void> {
    // BrowserTab has no public reveal method. Locate its editor by title and use
    // standard editor navigation, checking the browser identity before picking.
    if (vscode.window.activeBrowserTab !== tab) {
      const groups = vscode.window.tabGroups.all
      // BrowserTab.title is the editor's long title, including " (URL)".
      const suffix = ` (${tab.url})`
      const label = tab.title.endsWith(suffix) ? tab.title.slice(0, -suffix.length) : tab.title
      const group = groups.find((entry) => entry.tabs.some((editor) => editor.label === label))
      if (group) {
        for (let attempt = 0; attempt < groups.length && vscode.window.tabGroups.activeTabGroup !== group; attempt++) {
          await vscode.commands.executeCommand('workbench.action.focusNextGroup')
        }
        for (let attempt = 0; attempt < group.tabs.length && vscode.window.activeBrowserTab !== tab; attempt++) {
          await vscode.commands.executeCommand('workbench.action.nextEditorInGroup')
        }
      }
    }
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
  }

  private onEvent(run: PickerRun, event: Record<string, unknown>): void {
    if (this.run !== run) return
    const params = isRecord(event.params) ? event.params : {}
    if (event.method === 'Page.frameNavigated' || event.method === 'Page.navigatedWithinDocument' || event.method === 'Runtime.executionContextsCleared' ||
      (event.method === 'Runtime.executionContextDestroyed' && run.contexts.includes(Number(params.executionContextId)))) {
      void this.stop('Selection stopped because the page changed.')
      return
    }
    if (event.method !== 'Runtime.bindingCalled' || params.name !== run.binding || !run.contexts.includes(Number(params.executionContextId)) || typeof params.payload !== 'string') return
    try {
      const data: unknown = JSON.parse(params.payload)
      if (!isRecord(data)) return
      if (data.type === 'cancelled') { void this.stop(); return }
      if (data.type !== 'selected' || !isRecord(data.dimensions)) return
      const dimensions = data.dimensions
      if (!['top', 'left', 'width', 'height'].every((key) => typeof dimensions[key] === 'number' && Number.isFinite(dimensions[key]))) return
      if (!['url', 'label', 'selector', 'html', 'css'].every((key) => typeof data[key] === 'string')) return
      this.attachments.add({ id: randomUUID(), url: (data.url as string).slice(0, 4_096), label: (data.label as string).slice(0, 512),
        selector: (data.selector as string).slice(0, 4_096), html: (data.html as string).slice(0, this.limit), css: (data.css as string).slice(0, this.limit),
        dimensions: { top: Number(dimensions.top), left: Number(dimensions.left), width: Number(dimensions.width), height: Number(dimensions.height) }, truncated: data.truncated === true })
      this.publish()
    } catch { /* Ignore malformed binding messages; page content is untrusted. */ }
  }

  async stop(message?: string): Promise<void> {
    const run = this.run
    this.run = undefined
    this.message = message
    this.publish()
    if (!run?.client) return
    const client = run.client
    try {
      await Promise.allSettled(run.contexts.map((contextId) => client.request('Runtime.evaluate', {
        expression: `globalThis[${JSON.stringify(run.cleanup)}]?.()`, contextId,
      }, run.targetSession)))
      await client.request('Runtime.removeBinding', { name: run.binding }, run.targetSession).catch(() => undefined)
    } finally { await client.close().catch(() => undefined) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const subscription of this.subscriptions) subscription.dispose()
    await this.stop()
  }
}
