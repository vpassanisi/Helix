import 'basecoat-css/basecoat'
import 'basecoat-css/combobox'
import 'basecoat-css/dropdown-menu'
import 'basecoat-css/select'
import 'basecoat-css/popover'
import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { installWebviewCopySupport } from './lib/clipboard-copy.js'
import type { WebviewApi } from './types.js'

declare function acquireVsCodeApi(): WebviewApi

const vscode = acquireVsCodeApi()
const target = document.getElementById('app')

if (target === null) {
  throw new Error('Helix UI target was not found.')
}

/* VS Code takes Cmd+C inside a webview, so the selection is copied here. */
installWebviewCopySupport()

mount(App, {
  target,
  props: { vscode },
})
