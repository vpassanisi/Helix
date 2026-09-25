import { isAbsolute, relative, sep } from 'node:path'
import * as vscode from 'vscode'
import { countLines } from '../shared/value-utils.js'

export type CodeChangeKind = 'created' | 'modified' | 'deleted' | 'renamed'

export interface CodeChange {
  path: string
  kind: CodeChangeKind
  additions: number
  deletions: number
  oldPath?: string
}

export interface CodeChangeUpdate {
  sessionId: string
  changes: CodeChange[]
  active: boolean
}

type ChangeListener = (update: CodeChangeUpdate) => void

export class WorkspaceChangeTracker implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly changes = new Map<string, CodeChange>()
  private activeSessionId: string | undefined
  private finishTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly workspaceRoot: vscode.Uri | undefined,
    private readonly onChange: ChangeListener,
  ) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.handleDocumentChange(event)),
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files) this.recordUri({ path: uri, kind: 'created' })
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) this.recordUri({ path: uri, kind: 'deleted' })
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const file of event.files) {
          const path = this.relativePath(file.newUri)
          const oldPath = this.relativePath(file.oldUri)
          if (path !== undefined) {
            this.recordUri({ path: file.newUri, kind: 'renamed', oldPath })
          } else if (oldPath !== undefined) {
            this.recordUri({ path: file.oldUri, kind: 'deleted' })
          }
        }
      }),
    )

    if (workspaceRoot !== undefined) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, '**/*'),
      )
      this.subscriptions.push(
        watcher,
        watcher.onDidChange((uri) => this.recordUri({ path: uri, kind: 'modified' })),
        watcher.onDidCreate((uri) => this.recordUri({ path: uri, kind: 'created' })),
        watcher.onDidDelete((uri) => this.recordUri({ path: uri, kind: 'deleted' })),
      )
    }
  }

  start(sessionId: string): void {
    if (this.finishTimer !== undefined) {
      clearTimeout(this.finishTimer)
      this.finishTimer = undefined
    }
    this.activeSessionId = sessionId
    this.changes.clear()
    this.emit(true)
  }

  finish(sessionId: string): void {
    if (this.activeSessionId !== sessionId) return
    if (this.finishTimer !== undefined) clearTimeout(this.finishTimer)
    this.finishTimer = setTimeout(() => {
      this.finishTimer = undefined
      if (this.activeSessionId !== sessionId) return
      this.emit(false)
      this.activeSessionId = undefined
    }, 300)
  }

  dispose(): void {
    if (this.finishTimer !== undefined) clearTimeout(this.finishTimer)
    this.finishTimer = undefined
    this.activeSessionId = undefined
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0) return

    let additions = 0
    let deletions = 0
    for (const change of event.contentChanges) {
      additions += countLines(change.text)
      deletions += countRemovedLines(change.range)
    }
    this.recordUri({ path: event.document.uri, kind: 'modified', additions, deletions })
  }

  private recordUri(input: {
    path: vscode.Uri
    kind: CodeChangeKind
    additions?: number
    deletions?: number
    oldPath?: string
  }): void {
    const path = this.relativePath(input.path)
    if (path === undefined) return
    this.recordPath(path, input.kind, input.additions, input.deletions, input.oldPath)
  }

  private recordPath(
    path: string,
    kind: CodeChangeKind,
    additions = 0,
    deletions = 0,
    oldPath?: string,
  ): void {
    if (this.activeSessionId === undefined) return

    const existing = this.changes.get(path)
    this.changes.set(path, {
      path,
      kind: mergeKind(existing?.kind, kind),
      additions: (existing?.additions ?? 0) + additions,
      deletions: (existing?.deletions ?? 0) + deletions,
      oldPath: oldPath ?? existing?.oldPath,
    })
    this.emit(true)
  }

  private emit(active: boolean): void {
    if (this.activeSessionId === undefined) return
    this.onChange({
      sessionId: this.activeSessionId,
      changes: [...this.changes.values()].sort((left, right) => left.path.localeCompare(right.path)),
      active,
    })
  }

  private relativePath(uri: vscode.Uri): string | undefined {
    if (this.workspaceRoot === undefined || uri.scheme !== 'file') return undefined
    return this.workspaceRelativePath(uri.fsPath)
  }

  private workspaceRelativePath(filePath: string): string | undefined {
    if (this.workspaceRoot === undefined) return undefined
    const value = relative(this.workspaceRoot.fsPath, filePath)
    if (!value || isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`)) return undefined
    if (value === '.git' || value.startsWith(`.git${sep}`) || value === 'node_modules' || value.startsWith(`node_modules${sep}`)) return undefined
    return value.split(sep).join('/')
  }
}

function mergeKind(existing: CodeChangeKind | undefined, next: CodeChangeKind): CodeChangeKind {
  if (next === 'renamed' || next === 'deleted') return next
  if (existing === 'created' || existing === 'renamed') return existing
  return next
}

function countRemovedLines(range: vscode.Range): number {
  if (range.start.line === range.end.line && range.start.character === range.end.character) return 0
  return range.end.line - range.start.line + 1
}
