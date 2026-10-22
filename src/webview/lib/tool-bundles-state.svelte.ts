import { normalizeDisabledToolBundles } from '../../shared/tool-bundles.js'
import type { SidebarMessage, SidebarSettings } from '../types.js'

/**
 * The Tools page: the draft of bundles to leave out, the saved list, and the
 * message the page sends. Disabling a bundle is launch scoped, so a save never
 * restarts the running session; the runtime picks the change up at its next
 * start, which happens when the user opens a new session.
 */
export class ToolBundlesState {
  /** The draft on the page. */
  disabled = $state<string[]>([])
  /** The list saved in settings. */
  saved = $state<string[]>([])
  saving = $state(false)

  load(settings: SidebarSettings): void {
    this.saved = normalizeDisabledToolBundles(settings.disabledToolBundles)
    if (this.saving) {
      this.saving = false
      return
    }
    this.disabled = [...this.saved]
  }

  reset(): void {
    this.disabled = [...this.saved]
  }

  beginSave(): void {
    this.saving = true
  }

  saveRejected(reason: string): string {
    this.saving = false
    return `Could not send tool settings: ${reason}`
  }

  buildSaveMessage(): Extract<SidebarMessage, { type: 'saveTools' }> {
    return { type: 'saveTools', disabledToolBundles: normalizeDisabledToolBundles(this.disabled) }
  }
}
