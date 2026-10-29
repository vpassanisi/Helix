import { readFileSync } from 'node:fs'
import * as vscode from 'vscode'

/**
 * The webview bootstrap page: the compiled webview bundle, rewritten to load
 * its assets through the webview's CSP-safe origin with a fresh nonce. If the
 * bundle was never built (a raw install without `npm run compile`), the page
 * says so instead of hanging.
 */
export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
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
  <strong>Helix UI is not built.</strong>
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

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character)
}
