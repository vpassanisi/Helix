import type { CommandCatalog, CommandResult } from '../shared/commands.js'

export interface CommandControllerOptions {
  catalog: (sessionId: string) => Promise<CommandCatalog>
  run: (sessionId: string, name: string, args: string) => Promise<CommandResult>
  currentSession: () => string
  publishCatalog: (sessionId: string, catalog: CommandCatalog, error?: string) => void
  publishResult: (sessionId: string, name: string, kind: CommandResult['kind'], text?: string) => void
}

const UNAVAILABLE: CommandCatalog = { commands: [], available: false }

/**
 * Composer slash commands on the extension host side: the catalog the composer
 * lists, and one command run at a time. Commands are Host registry operations,
 * so this only ferries them and their results; the session log is written by the
 * Host, and the transcript cards come from those events.
 */
export class CommandController {
  private catalogGeneration = 0
  private running = false
  constructor(private readonly options: CommandControllerOptions) {}

  async load(sessionId: string): Promise<void> {
    const generation = ++this.catalogGeneration
    try {
      const catalog = await this.options.catalog(sessionId)
      if (generation === this.catalogGeneration && sessionId === this.options.currentSession()) {
        this.options.publishCatalog(sessionId, catalog)
      }
    } catch (error) {
      if (generation !== this.catalogGeneration || sessionId !== this.options.currentSession()) return
      this.options.publishCatalog(sessionId, UNAVAILABLE, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Runs one command. A `/compact` summarizes the conversation, which can take
   * a while, so a second command is refused rather than queued behind it.
   */
  async run(sessionId: string, name: string, args: string): Promise<void> {
    if (sessionId !== this.options.currentSession()) return
    if (this.running) {
      this.options.publishResult(sessionId, name, 'error', 'Another command is still running.')
      return
    }
    this.running = true
    try {
      const result = await this.options.run(sessionId, name, args)
      if (sessionId === this.options.currentSession()) {
        this.options.publishResult(sessionId, name, result.kind, result.text)
      }
    } catch (error) {
      if (sessionId === this.options.currentSession()) {
        this.options.publishResult(sessionId, name, 'error', error instanceof Error ? error.message : String(error))
      }
    } finally {
      this.running = false
    }
  }

  /** A runtime restart leaves the old registry behind. */
  invalidate(): void {
    ++this.catalogGeneration
  }
}
