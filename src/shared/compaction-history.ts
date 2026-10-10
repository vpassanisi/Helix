import { stringValue } from './value-utils.js'

export interface CompactionEntry {
  key: string
  sessionId: string
  kind: 'summary' | 'prune'
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  historyItems?: number
  shadowedTokens?: number
  pruneCount?: number
  error?: string
}

/** Correlate lifecycle events so each operation keeps one permanent history entry. */
export class CompactionHistory {
  private entries = new Map<string, CompactionEntry>()
  private pruneGroups = new Map<string, string>()
  private nextPruneId = 0

  record(sessionId: string, type: string, data: Record<string, unknown>): CompactionEntry | undefined {
    if (type === 'step/start' || type === 'turn/end') this.pruneGroups.delete(sessionId)
    if (type === 'compaction/prune') {
      const key = this.pruneGroups.get(sessionId) ?? JSON.stringify([sessionId, 'prune', ++this.nextPruneId])
      this.pruneGroups.set(sessionId, key)
      const entry: CompactionEntry = {
        key, sessionId, kind: 'prune', status: 'completed',
        pruneCount: (this.entries.get(key)?.pruneCount ?? 0) + 1,
      }
      this.entries.set(key, entry)
      return entry
    }
    if (type !== 'compaction/start' && type !== 'compaction/summary' && type !== 'compaction/end') return
    const compactionId = stringValue(data.compactionId)
    if (!compactionId) return
    this.pruneGroups.delete(sessionId)
    const key = JSON.stringify([sessionId, 'summary', compactionId])
    const previous = this.entries.get(key)
    let entry: CompactionEntry = previous ?? { key, sessionId, kind: 'summary', status: 'running' }
    if (type === 'compaction/summary') {
      entry = {
        ...entry,
        historyItems: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : undefined,
        shadowedTokens: typeof data.shadowedTokenCount === 'number' && Number.isFinite(data.shadowedTokenCount)
          ? Math.max(0, data.shadowedTokenCount) : undefined,
      }
    } else if (type === 'compaction/end') {
      const error = stringValue(data.error)
      entry = { ...entry, status: error ? 'failed' : 'completed', error }
    }
    this.entries.set(key, entry)
    return entry
  }

  interrupt(sessionId?: string, error?: string): CompactionEntry[] {
    const changed: CompactionEntry[] = []
    for (const [key, entry] of this.entries) {
      if (entry.status !== 'running' || (sessionId !== undefined && entry.sessionId !== sessionId)) continue
      const next: CompactionEntry = { ...entry, status: error ? 'failed' : 'interrupted', error }
      this.entries.set(key, next)
      changed.push(next)
    }
    return changed
  }

  reset(): void {
    this.entries.clear()
    this.pruneGroups.clear()
    this.nextPruneId = 0
  }
}

export function compactionTitle(entry: CompactionEntry): string {
  if (entry.kind === 'prune') return 'Tool results trimmed'
  if (entry.status === 'running') return 'Compacting conversation…'
  if (entry.status === 'failed') return 'Compaction failed'
  if (entry.status === 'interrupted') return 'Compaction interrupted'
  return 'Conversation compacted'
}

export function compactionDetail(entry: CompactionEntry): string {
  if (entry.error) return entry.error
  if (entry.kind === 'prune') {
    const count = entry.pruneCount ?? 1
    return `${count} large tool result${count === 1 ? '' : 's'} shortened to free up context.`
  }
  if (entry.status === 'interrupted') return 'Stopped before completion was confirmed.'
  const metrics: string[] = []
  if (entry.historyItems !== undefined) metrics.push(`${entry.historyItems} history entries`)
  if (entry.shadowedTokens !== undefined) metrics.push(`${Math.round(entry.shadowedTokens).toLocaleString('en-US')} tokens of earlier context`)
  if (entry.status === 'running') return 'Summarizing earlier turns to make room for the next steps.'
  return metrics.length > 0 ? `${metrics.join(' · ')} summarized.` : 'Earlier turns summarized; recent context retained.'
}
