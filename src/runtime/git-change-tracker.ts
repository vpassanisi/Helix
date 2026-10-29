import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import type * as vscode from 'vscode'
import type { CodeChange, CodeChangeKind } from '../shared/code-changes.js'
import type { ChangeListener, ChangeTracker } from './change-tracker.js'

const POLL_INTERVAL_MS = 1_500
const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024

/**
 * Sources the changes drawer from git. A turn snapshots the working tree into a
 * throw-away index (tracked + untracked, so the repo's own .gitignore decides
 * what counts) and, live and at the end of the turn, diffs that baseline tree
 * against the current tree. The result is a real diff — correct files, kinds,
 * and +/- line counts — instead of the old event heuristics. A workspace that
 * is not a git work tree reports no changes, so the drawer stays hidden.
 */
export class GitChangeTracker implements ChangeTracker {
  private readonly indexFile: string
  private readonly workspaceRoot: vscode.Uri | undefined
  private readonly onChange: ChangeListener
  private activeSessionId: string | undefined
  private gitAvailable = false
  private baselineTree: string | undefined
  private lastTree: string | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(workspaceRoot: vscode.Uri | undefined, onChange: ChangeListener) {
    this.workspaceRoot = workspaceRoot
    this.onChange = onChange
    this.indexFile = join(tmpdir(), `helix-change-index-${randomBytes(6).toString('hex')}`)
  }

  start(sessionId: string): void {
    this.stopPolling()
    this.activeSessionId = sessionId
    this.baselineTree = undefined
    this.lastTree = undefined
    this.gitAvailable = false
    void this.beginTurn(sessionId)
  }

  finish(sessionId: string): void {
    if (this.activeSessionId !== sessionId) return
    this.stopPolling()
    void this.finishTurn(sessionId)
  }

  dispose(): void {
    this.disposed = true
    this.stopPolling()
    this.activeSessionId = undefined
    rmSync(this.indexFile, { force: true })
  }

  private async beginTurn(sessionId: string): Promise<void> {
    const root = this.workspaceRoot?.fsPath
    if (root === undefined) {
      this.emit([], true)
      return
    }
    const inside = await this.git(root, ['rev-parse', '--is-inside-work-tree']).catch(() => '')
    if (inside.trim() !== 'true') {
      this.gitAvailable = false
      this.emit([], true)
      return
    }
    const baseline = await this.snapshotTree(root, true)
    if (this.disposed || this.activeSessionId !== sessionId) return
    if (baseline === undefined) {
      this.gitAvailable = false
      this.emit([], true)
      return
    }
    this.gitAvailable = true
    this.baselineTree = baseline
    this.lastTree = baseline
    this.emit([], true)
    this.startPolling()
  }

  private async finishTurn(sessionId: string): Promise<void> {
    const root = this.workspaceRoot?.fsPath
    let changes: CodeChange[] = []
    if (root !== undefined && this.gitAvailable && this.baselineTree !== undefined) {
      const current = await this.snapshotTree(root, false)
      if (current !== undefined) changes = await this.diffTrees(root, this.baselineTree, current)
    }
    if (this.disposed || this.activeSessionId !== sessionId) return
    this.activeSessionId = undefined
    this.gitAvailable = false
    this.baselineTree = undefined
    this.lastTree = undefined
    // Post directly (not via emit): the active session is cleared above, and the
    // final frame must still reach the Webview to close out the drawer.
    this.onChange({ sessionId, changes, active: false })
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined) return
    this.pollTimer = setInterval(() => { void this.poll() }, POLL_INTERVAL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private async poll(): Promise<void> {
    const sessionId = this.activeSessionId
    const root = this.workspaceRoot?.fsPath
    if (sessionId === undefined || root === undefined || !this.gitAvailable || this.baselineTree === undefined) return
    const current = await this.snapshotTree(root, false)
    if (this.disposed || this.activeSessionId !== sessionId || current === undefined) return
    if (current === this.lastTree) return
    this.lastTree = current
    const changes = await this.diffTrees(root, this.baselineTree, current)
    if (this.disposed || this.activeSessionId !== sessionId) return
    this.emit(changes, true)
  }

  /**
   * Snapshot the working tree into the throw-away index and return its tree id.
   * The first snapshot of a turn starts from a clean index; later ones reuse it,
   * so `git add -A` only re-hashes the files that changed since the last
   * snapshot and polling stays cheap.
   */
  private async snapshotTree(root: string, fresh: boolean): Promise<string | undefined> {
    try {
      if (fresh) rmSync(this.indexFile, { force: true })
      const env = { GIT_INDEX_FILE: this.indexFile }
      await this.git(root, ['add', '-A'], env)
      return (await this.git(root, ['write-tree'], env)).trim() || undefined
    } catch {
      return undefined
    }
  }

  private async diffTrees(root: string, base: string, current: string): Promise<CodeChange[]> {
    const [nameStatus, numstat] = await Promise.all([
      this.git(root, ['diff', '--name-status', base, current]).catch(() => ''),
      this.git(root, ['diff', '--numstat', base, current]).catch(() => ''),
    ])
    return this.buildChanges(nameStatus, numstat)
  }

  private buildChanges(nameStatus: string, numstat: string): CodeChange[] {
    const counts = new Map<string, { additions: number; deletions: number }>()
    for (const line of numstat.split('\n')) {
      const parts = line.trim().split('\t')
      if (parts.length < 3) continue
      let path = parts.slice(2).join('\t')
      const arrow = path.indexOf(' => ')
      if (arrow !== -1) path = path.slice(arrow + 4)
      counts.set(path, { additions: parseCount(parts[0]), deletions: parseCount(parts[1]) })
    }
    const changes = new Map<string, CodeChange>()
    for (const line of nameStatus.split('\n')) {
      const parts = line.trim().split('\t')
      const code = parts[0]?.[0]
      if (code === undefined) continue
      let kind: CodeChangeKind
      if (code === 'A') kind = 'created'
      else if (code === 'D') kind = 'deleted'
      else if (code === 'R' || code === 'C') kind = 'renamed'
      else kind = 'modified'
      let path: string | undefined
      let oldPath: string | undefined
      if (code === 'R' || code === 'C') {
        oldPath = parts[1]
        path = parts[2]
      } else {
        path = parts[1]
      }
      if (path === undefined) continue
      const c = counts.get(path)
      changes.set(path, {
        path,
        kind,
        additions: c?.additions ?? 0,
        deletions: c?.deletions ?? 0,
        ...(oldPath === undefined ? {} : { oldPath }),
      })
    }
    return [...changes.values()].sort((left, right) => left.path.localeCompare(right.path))
  }

  private emit(changes: CodeChange[], active: boolean): void {
    const sessionId = this.activeSessionId
    if (sessionId === undefined) return
    this.onChange({ sessionId, changes, active })
  }

  private git(root: string, args: string[], env?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: GIT_MAX_BUFFER,
          timeout: GIT_TIMEOUT_MS,
          ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
        },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      )
    })
  }
}

function parseCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
