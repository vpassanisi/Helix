import type { Disposable } from 'vscode'
import type { CodeChange } from '../shared/code-changes.js'

export type { CodeChange, CodeChangeKind } from '../shared/code-changes.js'

export interface CodeChangeUpdate {
  sessionId: string
  changes: CodeChange[]
  active: boolean
}

export type ChangeListener = (update: CodeChangeUpdate) => void

/**
 * The host-side source of the changes drawer. `start` opens a turn and `finish`
 * closes it; while a turn is active the tracker emits a `CodeChangeUpdate` as
 * the set of workspace changes grows. The concrete implementation reads the
 * changes from git, so the drawer shows a real diff rather than an event
 * heuristic.
 */
export interface ChangeTracker extends Disposable {
  start(sessionId: string): void
  finish(sessionId: string): void
}
