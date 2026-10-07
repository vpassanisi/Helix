// Browser proposal shape verified against VS Code 1.140.0. Experimental API.
declare module 'vscode' {
  export interface BrowserTab {
    readonly url: string
    readonly title: string
    readonly icon: IconPath
    startCDPSession(): Thenable<BrowserCDPSession>
    close(): Thenable<void>
  }
  export interface BrowserCDPSession {
    readonly onDidReceiveMessage: Event<unknown>
    readonly onDidClose: Event<void>
    sendMessage(message: unknown): Thenable<void>
    close(): Thenable<void>
  }
  export namespace window {
    const browserTabs: readonly BrowserTab[]
    const activeBrowserTab: BrowserTab | undefined
    const onDidOpenBrowserTab: Event<BrowserTab>
    const onDidCloseBrowserTab: Event<BrowserTab>
    const onDidChangeActiveBrowserTab: Event<BrowserTab | undefined>
    const onDidChangeBrowserTabState: Event<BrowserTab>
    function openBrowserTab(url: string, options?: { viewColumn?: ViewColumn; preserveFocus?: boolean; background?: boolean }): Thenable<BrowserTab>
  }
}
