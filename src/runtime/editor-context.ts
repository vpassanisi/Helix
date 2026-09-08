import path from 'node:path'
import * as vscode from 'vscode'
import type { EditorContext } from './prompt-context.js'

export function captureEditorContext(editor: vscode.TextEditor | undefined): EditorContext | undefined {
  if (editor === undefined) return undefined

  const ranges = editor.selections
    .filter((selection) => !selection.isEmpty)
    .map((selection) => ({
      startLine: selection.start.line + 1,
      startColumn: selection.start.character + 1,
      endLine: selection.end.line + 1,
      endColumn: selection.end.character + 1,
      text: editor.document.getText(selection),
    }))

  if (ranges.length === 0) return undefined

  return {
    fileLabel: displayFileLabel(editor.document.uri),
    languageId: editor.document.languageId,
    ranges,
  }
}

export function editorContextMetadata(
  editor: vscode.TextEditor | undefined,
): Omit<EditorContext, 'ranges'> & { ranges: Array<Omit<EditorContext['ranges'][number], 'text'>> } | undefined {
  const context = captureEditorContext(editor)
  if (context === undefined) return undefined

  return {
    fileLabel: context.fileLabel,
    languageId: context.languageId,
    ranges: context.ranges.map(({ text: _text, ...range }) => range),
  }
}

function displayFileLabel(uri: vscode.Uri): string {
  if (uri.scheme !== 'file') return uri.toString()

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
  if (workspaceFolder === undefined) return uri.fsPath

  const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
  return relativePath.length === 0 ? path.basename(uri.fsPath) : relativePath.split(path.sep).join('/')
}
