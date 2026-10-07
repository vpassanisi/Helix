import type { BrowserElementContext } from '../shared/browser-context.js'
import { limitBrowserContext } from '../shared/browser-context.js'

export class BrowserAttachments {
  private elements: BrowserElementContext[] = []
  constructor(public sessionId: string) {}
  reset(sessionId: string): void { this.sessionId = sessionId; this.elements = [] }
  add(element: BrowserElementContext): void { this.elements.push(element) }
  remove(id: string): void { this.elements = this.elements.filter((element) => element.id !== id) }
  snapshot(sessionId: string, ids: readonly string[], limit: number): BrowserElementContext[] {
    if (sessionId !== this.sessionId) throw new Error('Browser attachments belong to a different chat session')
    const unique = [...new Set(ids)]
    const elements = unique.map((id) => {
      const element = this.elements.find((entry) => entry.id === id)
      if (!element) throw new Error('A browser attachment was removed. Review the attachments and send again.')
      return element
    })
    return limitBrowserContext(elements, limit)
  }
  consume(sessionId: string, ids: readonly string[]): void {
    if (sessionId === this.sessionId) this.elements = this.elements.filter((element) => !ids.includes(element.id))
  }
  list(limit: number): BrowserElementContext[] { return limitBrowserContext(this.elements, limit) }
}
