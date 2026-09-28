import 'basecoat-css/basecoat'
import 'basecoat-css/combobox'
import 'basecoat-css/dropdown-menu'
import 'basecoat-css/select'
import 'basecoat-css/popover'
import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import type { WebviewApi } from './types.js'

declare function acquireVsCodeApi(): WebviewApi

const vscode = acquireVsCodeApi()
const target = document.getElementById('app')

if (target === null) {
  throw new Error('Helix UI target was not found.')
}

mount(App, {
  target,
  props: { vscode },
})
