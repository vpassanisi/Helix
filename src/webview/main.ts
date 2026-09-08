import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import type { WebviewApi } from './types.js'

declare function acquireVsCodeApi(): WebviewApi

const vscode = acquireVsCodeApi()
const target = document.getElementById('app')

if (target === null) {
  throw new Error('DeepSeek Harness UI target was not found.')
}

mount(App, {
  target,
  props: { vscode },
})
