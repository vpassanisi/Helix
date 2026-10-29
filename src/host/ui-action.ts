import * as vscode from 'vscode'
import type { GenUiAction } from '../shared/gen-ui.js'

/**
 * Carries out a card intent that already passed the wire check and the
 * workspace check: links go to the system browser, paths open in the editor,
 * and everything that touches a session (prompt, inject, copy, dismiss) is
 * handed back to the session handler. Nothing is opened quietly in the
 * background.
 */
export async function performUiAction(
  action: GenUiAction,
  onSessionAction: (action: GenUiAction) => Promise<void>,
  postError: (error: unknown) => void,
): Promise<void> {
  if (action.kind === 'openLink') {
    if (!await vscode.env.openExternal(vscode.Uri.parse(action.url))) {
      postError(new Error(`VS Code did not open ${action.url}`))
    }
    return
  }
  if (action.kind === 'openPath') {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(action.path))
      await vscode.window.showTextDocument(document, { preview: true })
    } catch {
      postError(new Error(`${action.label ?? action.path} could not be opened. It may have been deleted, or it may live in a folder VS Code is not showing.`))
    }
    return
  }
  await onSessionAction(action)
}
