import { isAbsolute, relative, resolve, sep } from 'node:path'
import * as vscode from 'vscode'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'

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

interface PendingToolChange {
  path: string
  kind: CodeChangeKind
  additions: number
  deletions: number
}

export class WorkspaceChangeTracker implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly changes = new Map<string, CodeChange>()
  private readonly pendingToolChanges = new Map<string, PendingToolChange>()
  private readonly toolTrackedPaths = new Set<string>()
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
    this.pendingToolChanges.clear()
    this.toolTrackedPaths.clear()
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
      this.pendingToolChanges.clear()
      this.toolTrackedPaths.clear()
    }, 300)
  }

  dispose(): void {
    if (this.finishTimer !== undefined) clearTimeout(this.finishTimer)
    this.finishTimer = undefined
    this.activeSessionId = undefined
    this.pendingToolChanges.clear()
    this.toolTrackedPaths.clear()
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
  }

  observeNotification(rootSessionId: string, notification: HarnessNotification): void {
    if (this.activeSessionId !== rootSessionId || !isRecord(notification)) return
    const params = isRecord(notification.params) ? notification.params : {}
    if (notification.method !== 'session.event' || !isRecord(params.event)) return

    const event = params.event
    const data = isRecord(event.data) ? event.data : {}
    if (event.type === 'tool/call') {
      const name = stringValue(data.name)
      const argumentsValue = parsePayload(data.arguments)
      const change = name === undefined || argumentsValue === undefined
        ? undefined
        : toolChange(name, argumentsValue)
      const key = toolCallKey(data)
      const path = change === undefined ? undefined : this.workspaceRelativeToolPath(change.path)
      if (change !== undefined && path !== undefined && key !== undefined) {
        this.pendingToolChanges.set(key, { ...change, path })
      }
      return
    }

    if (event.type !== 'tool/result') return
    const key = toolResultKey(data)
    if (key === undefined) return
    const change = this.pendingToolChanges.get(key)
    this.pendingToolChanges.delete(key)
    if (change === undefined || toolResultFailed(data)) return
    this.toolTrackedPaths.add(change.path)
    const kind = change.kind === 'modified' && toolResultCreated(data) ? 'created' : change.kind
    this.recordPath(change.path, kind, change.additions, change.deletions, undefined, true)
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
    fromTool = false,
  ): void {
    if (this.activeSessionId === undefined) return

    const existing = this.changes.get(path)
    const shouldCount = fromTool || !this.toolTrackedPaths.has(path)
    this.changes.set(path, {
      path,
      kind: mergeKind(existing?.kind, kind),
      additions: (existing?.additions ?? 0) + (shouldCount ? additions : 0),
      deletions: (existing?.deletions ?? 0) + (shouldCount ? deletions : 0),
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

  private workspaceRelativeToolPath(filePath: string): string | undefined {
    const absolutePath = isAbsolute(filePath) ? filePath : resolve(this.workspaceRoot?.fsPath ?? '', filePath)
    return this.workspaceRelativePath(absolutePath)
  }
}

function mergeKind(existing: CodeChangeKind | undefined, next: CodeChangeKind): CodeChangeKind {
  if (next === 'renamed' || next === 'deleted') return next
  if (existing === 'created' || existing === 'renamed') return existing
  return next
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length
}

function countRemovedLines(range: vscode.Range): number {
  if (range.start.line === range.end.line && range.start.character === range.end.character) return 0
  return range.end.line - range.start.line + 1
}

function toolChange(name: string, argumentsValue: Record<string, unknown>): PendingToolChange | undefined {
  const normalizedName = name.toLowerCase()
  const filePath = stringValue(argumentsValue.file_path) ?? stringValue(argumentsValue.filePath) ?? stringValue(argumentsValue.path)
  if (filePath === undefined) return undefined

  if (normalizedName === 'write' || /(?:^|[/_.])write$/.test(normalizedName) || /(?:^|__)write$/.test(normalizedName)) {
    const content = textValue(argumentsValue.content)
    if (content === undefined) return undefined
    return { path: filePath, kind: 'modified', additions: countLines(content), deletions: 0 }
  }

  if (normalizedName === 'edit' || /(?:^|[/_.])edit$/.test(normalizedName) || /(?:^|__)edit$/.test(normalizedName)) {
    const oldString = stringValue(argumentsValue.old_string) ?? stringValue(argumentsValue.oldString)
    const newString = textValue(argumentsValue.new_string) ?? textValue(argumentsValue.newString)
    if (oldString === undefined || newString === undefined) return undefined
    return { path: filePath, kind: 'modified', additions: countLines(newString), deletions: countLines(oldString) }
  }

  if (!normalizedName.includes('str_replace_editor')) return undefined
  const command = stringValue(argumentsValue.command)
  if (command === 'create') {
    const fileText = textValue(argumentsValue.file_text) ?? textValue(argumentsValue.fileText) ?? ''
    return { path: filePath, kind: 'created', additions: countLines(fileText), deletions: 0 }
  }
  if (command === 'str_replace') {
    const oldString = stringValue(argumentsValue.old_str) ?? stringValue(argumentsValue.oldStr)
    const newString = textValue(argumentsValue.new_str) ?? textValue(argumentsValue.newStr) ?? ''
    if (oldString === undefined) return undefined
    return { path: filePath, kind: 'modified', additions: countLines(newString), deletions: countLines(oldString) }
  }
  if (command === 'insert') {
    const newString = textValue(argumentsValue.new_str) ?? textValue(argumentsValue.newStr) ?? ''
    return { path: filePath, kind: 'modified', additions: countLines(newString), deletions: 0 }
  }
  return undefined
}

function toolCallKey(data: Record<string, unknown>): string | undefined {
  return stringValue(data.callId) ?? responseKey(data)
}

function toolResultKey(data: Record<string, unknown>): string | undefined {
  const direct = stringValue(data.callId)
  if (direct) return direct
  const message = isRecord(data.message) ? data.message : undefined
  const source = message && isRecord(message.source) ? message.source : undefined
  const sourceCallId = source ? stringValue(source.callId) : undefined
  if (sourceCallId) return sourceCallId
  if (message && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue
      const blockCallId = stringValue(block.toolCallId)
      if (blockCallId) return blockCallId
    }
  }
  return responseKey(data)
}

function responseKey(data: Record<string, unknown>): string | undefined {
  return Number.isInteger(data.turn) && Number.isInteger(data.step)
    ? `${String(data.turn)}:${String(data.step)}`
    : undefined
}

function toolResultFailed(data: Record<string, unknown>): boolean {
  if (data.error !== undefined && data.error !== null) return true
  const message = isRecord(data.message) ? data.message : undefined
  return message !== undefined && contentHasError(message.content)
}

function contentHasError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(contentHasError)
  return isRecord(value) && (value.isError === true || contentHasError(value.content))
}

function toolResultCreated(data: Record<string, unknown>): boolean {
  const message = isRecord(data.message) ? data.message : undefined
  return message !== undefined && /created file/i.test(contentText(message.content))
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).join('\n')
  if (!isRecord(value)) return ''
  if (typeof value.text === 'string') return value.text
  return contentText(value.content)
}

function parsePayload(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
