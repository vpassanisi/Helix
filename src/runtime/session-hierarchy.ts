import { stringValue } from '../shared/value-utils.js'

export class SessionHierarchy {
  private readonly parents = new Map<string, string>()

  track(method: string | undefined, params: Record<string, unknown>): void {
    const parentSessionId = stringValue(params.parentSessionId)
    const childSessionId = stringValue(params.childSessionId)
    if (parentSessionId === undefined || childSessionId === undefined || parentSessionId === childSessionId) return

    if (method === 'subagent.started') this.parents.set(childSessionId, parentSessionId)
    else if (method === 'subagent.finished') this.parents.delete(childSessionId)
  }

  owns(rootSessionId: string, sessionId: string): boolean {
    const visited = new Set<string>()
    let current = sessionId
    while (!visited.has(current)) {
      if (current === rootSessionId) return true
      visited.add(current)
      const parent = this.parents.get(current)
      if (parent === undefined) return false
      current = parent
    }
    return false
  }

  clear(): void {
    this.parents.clear()
  }
}
