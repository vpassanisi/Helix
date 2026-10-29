import * as vscode from 'vscode'
import type { HarnessRuntime } from '../runtime/harness-runtime.js'

/**
 * Arms the runtime to capture the next OpenAI Chat Completions request and
 * reports it in the output channel. Authorization headers are not captured.
 */
export async function armProviderRequestCapture(
  runtime: HarnessRuntime,
  sessionId: string,
  channel: vscode.OutputChannel,
): Promise<void> {
  try {
    channel.clear()
    channel.appendLine('Waiting for the next OpenAI Chat Completions request. Send one message in Helix.')
    channel.appendLine('The capture includes prompt and workspace context. Authorization headers are not captured.')
    channel.show(true)
    await runtime.captureNextProviderRequest(sessionId)
  } catch (error) {
    channel.appendLine(`Could not arm capture: ${error instanceof Error ? error.message : String(error)}`)
    channel.show(true)
  }
}

/** The captured request, pretty-printed into the output channel. */
export function appendCapturedProviderRequest(channel: vscode.OutputChannel, params: Record<string, unknown>): void {
  const url = typeof params.url === 'string' ? params.url : '(unknown URL)'
  channel.appendLine(`Captured provider request: POST ${url}`)
  if (typeof params.body !== 'string') {
    channel.appendLine('The request body was not available as text.')
    return
  }
  try {
    channel.appendLine(JSON.stringify(JSON.parse(params.body), null, 2))
  } catch {
    channel.appendLine(params.body)
  }
  channel.show(true)
}
