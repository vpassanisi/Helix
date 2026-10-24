import {
  commandPopupOpen,
  completeCommand,
  filterCommands,
  parseCommandInvocation,
  slashTrigger,
  type CommandCatalog,
  type CommandInvocation,
  type ComposerCommand,
} from '../../shared/commands.js'
import type { SidebarMessage } from '../types.js'

const EMPTY_CATALOG: CommandCatalog = { commands: [], available: false }

/** Where the popup opens: the box of the `/` it opened on, fixed while the name is typed. */
export interface CommandAnchor {
  x: number
  y: number
}

/**
 * Slash commands in the composer: the catalog the Host published, the popup
 * anchored on the `/` being typed, and the command a finished line runs.
 *
 * The composer owns typing and the caret and pushes both here; everything the
 * popup shows is derived from that draft, so it cannot fall behind the text.
 */
export class ComposerCommandState {
  catalog = $state<CommandCatalog>({ ...EMPTY_CATALOG })
  error = $state('')
  /** The composer text and caret, pushed on every keystroke. */
  draft = $state({ text: '', caret: 0 })
  anchor = $state<CommandAnchor>({ x: 0, y: 0 })
  /** Highlighted row; `-1` while nothing is listable. */
  active = $state(-1)
  /**
   * The name a command was completed to, or the token Escape closed the popup
   * on; `undefined` when nothing has been completed or dismissed. The popup
   * stays shut while the caret edits that token, so completing a command does
   * not reopen it, and naming a new one lists again.
   */
  private dismissed = $state<string | undefined>(undefined)
  /** Whether the popup was open on the last pass, so a new session can start at row 0. */
  private wasOpen = false

  constructor(
    private readonly post: (message: SidebarMessage) => void,
    private readonly session: () => string,
  ) {
    this.keepActive()
  }

  /** The `/` being typed, and the draft offset that `/` sits at. */
  trigger = $derived(slashTrigger(this.draft.text, this.draft.caret))
  /** A registry the runtime refused still opens the popup, to say why. */
  open = $derived(commandPopupOpen(this.draft.text, this.draft.caret, this.dismissed)
    && (this.catalog.available ? this.catalog.commands.length > 0 : this.error.length > 0))
  matches = $derived(this.open && this.catalog.available ? filterCommands(this.catalog.commands, this.trigger?.query ?? '') : [])
  activeCommand = $derived(this.matches[this.active] as ComposerCommand | undefined)
  /** The popup's line when the list is empty: the host's reason, or no match. */
  emptyMessage = $derived(this.catalog.available ? 'No command matches that name.' : this.error)

  /** Asks for the catalog whenever a session becomes active. */
  start(): void {
    $effect(() => {
      const sessionId = this.session()
      if (sessionId) this.post({ type: 'loadCommands', sessionId })
    })
  }

  /** Keeps the highlighted row on a row that is still listed, and starts each popup session on the best match. */
  private keepActive(): void {
    $effect(() => {
      const rows = this.matches.length
      if (!this.open) {
        this.wasOpen = false
        this.active = -1
        return
      }
      if (!this.wasOpen) {
        this.wasOpen = true
        this.active = 0
        return
      }
      this.active = rows > 0 ? Math.min(Math.max(this.active, 0), rows - 1) : -1
    })
  }

  /** Recompute the popup from the composer's text and caret. */
  sync(text: string, caret: number): void {
    this.draft = { text, caret }
  }

  move(delta: number): void {
    const rows = this.matches.length
    if (rows === 0) return
    this.active = (this.active + delta + rows) % rows
  }

  /**
   * The composer text and caret after completing the highlighted row. The
   * completed draft is written here too: a completion is programmatic, so no
   * keystroke re-pushes it, and the popup is measured against the draft it now
   * holds — which is what shuts the popup on the spot.
   */
  accept(): { text: string; caret: number } | undefined {
    const command = this.activeCommand
    if (command === undefined) return undefined
    const completed = completeCommand(this.draft.text, this.draft.caret, command)
    this.dismissed = command.name
    this.draft = completed
    return completed
  }

  /**
   * Close the popup. A dismissal sticks: the popup stays shut while the caret
   * edits that token, so Escape and completing a command do not reopen it.
   * Leaving the composer is not a dismissal — coming back to the same token
   * should list again.
   */
  close(sticky = true): void {
    this.dismissed = sticky ? this.trigger?.query : undefined
  }

  /** The command a finished line runs, when its leading token names a known command. */
  invocation(text: string): CommandInvocation | undefined {
    const parsed = parseCommandInvocation(text)
    if (parsed === undefined || !this.knows(parsed.name)) return undefined
    return parsed
  }

  knows(name: string): boolean {
    return this.catalog.commands.some((command) => command.name === name)
  }

  applyCatalog(catalog: CommandCatalog, error?: string): void {
    this.catalog = catalog
    this.error = error ?? ''
  }

  clear(): void {
    this.catalog = { ...EMPTY_CATALOG }
    this.error = ''
    this.dismissed = undefined
  }
}
