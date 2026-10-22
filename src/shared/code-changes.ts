import { countLines, stringValue } from './value-utils.js'

export type CodeChangeKind = 'created' | 'modified' | 'deleted' | 'renamed'

export interface CodeChange {
  path: string
  kind: CodeChangeKind
  additions: number
  deletions: number
  oldPath?: string
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function mergeChangeKind(existing: CodeChangeKind, next: CodeChangeKind): CodeChangeKind {
  if (next === 'renamed' || next === 'deleted') return next
  if (existing === 'created' || existing === 'renamed') return existing
  return next
}

export function mergeHostChanges(current: CodeChange[], incoming: CodeChange[]): CodeChange[] {
  const merged = new Map(current.map((change) => [change.path, change]))
  for (const change of incoming) {
    const existing = merged.get(change.path)
    if (existing === undefined) {
      merged.set(change.path, change)
      continue
    }
    merged.set(change.path, {
      ...existing,
      kind: mergeChangeKind(existing.kind, change.kind),
      additions: Math.max(existing.additions, change.additions),
      deletions: Math.max(existing.deletions, change.deletions),
      oldPath: change.oldPath ?? existing.oldPath,
    })
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path))
}

export function recordToolChange(current: CodeChange[], derivedPaths: Set<string>, change: CodeChange): CodeChange[] {
  const existing = current.find((entry) => entry.path === change.path)
  const alreadyDerived = derivedPaths.has(change.path)
  const nextChange: CodeChange = existing === undefined
    ? change
    : {
        ...existing,
        kind: mergeChangeKind(existing.kind, change.kind),
        additions: alreadyDerived
          ? existing.additions + change.additions
          : Math.max(existing.additions, change.additions),
        deletions: alreadyDerived
          ? existing.deletions + change.deletions
          : Math.max(existing.deletions, change.deletions),
      }

  derivedPaths.add(change.path)
  return existing === undefined
    ? [...current, nextChange].sort((left, right) => left.path.localeCompare(right.path))
    : current.map((entry) => entry.path === change.path ? nextChange : entry)
}

export function toolChange(name: string, argumentsValue: Record<string, unknown>): CodeChange | undefined {
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
