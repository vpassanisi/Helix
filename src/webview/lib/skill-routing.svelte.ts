import { untrack } from 'svelte'
import {
  recentChatContext,
  type DecisionSettings,
  type SkillCatalog,
  type SkillDraft,
  type SkillOverrides,
  type SkillSuggestions,
} from '../../shared/skills.js'
import type { SidebarMessage } from '../types.js'

export interface SkillRoutingContext {
  enabled: boolean
  sessionId: string
  isGenerating: boolean
  hasPendingSubmission: boolean
  prompt: string
  decisions: DecisionSettings | undefined
  languageId: string | undefined
}

const EMPTY_CATALOG: SkillCatalog = { skills: [], revision: '', complete: false }

/**
 * Skill routing: the catalog the composer lists, the suggestions the router
 * returned for the current draft, and the manual include/exclude overrides.
 */
export class SkillRoutingState {
  catalog = $state<SkillCatalog>({ ...EMPTY_CATALOG })
  error = $state('')
  suggestions = $state<SkillSuggestions | undefined>()
  overrides = $state<SkillOverrides>({ include: [], exclude: [] })
  epoch = $state(0)
  private revision = 0
  private lastAnalyzed = ''

  constructor(
    private readonly post: (message: SidebarMessage) => void,
    private readonly context: () => SkillRoutingContext,
    private readonly chatTurns: () => SkillDraft['recentChat'],
  ) {}

  /** Loads the catalog when a session becomes active. */
  start(): void {
    $effect(() => {
      const { enabled, sessionId } = this.context()
      if (!enabled || !sessionId) return
      this.post({ type: 'loadSkills', sessionId })
    })
  }

  /**
   * Re-asks the router when the draft changes: the prompt, the chat in front of
   * it, the catalog revision, the decision settings, the editor selection, or a
   * skills invalidation. The key keeps one analysis per draft.
   */
  watch(): void {
    $effect(() => {
      const ctx = this.context()
      if (!ctx.enabled || !ctx.sessionId || ctx.isGenerating || ctx.hasPendingSubmission) return
      const prompt = ctx.prompt.trim()
      const draft = untrack(() => this.draft(ctx.sessionId, prompt))
      const key = JSON.stringify([
        draft.sessionId, prompt, draft.recentChat, this.catalog.revision, ctx.decisions, ctx.languageId, this.epoch,
      ])
      if (key === this.lastAnalyzed) return
      this.lastAnalyzed = key
      draft.revision = untrack(() => ++this.revision)
      this.suggestions = {
        sessionId: draft.sessionId, revision: draft.revision, selected: [], probabilities: {},
        status: prompt ? 'checking' : 'disabled',
      }
      this.post({ type: 'analyzeSkills', draft })
    })
  }

  draft(sessionId: string, text: string): SkillDraft {
    return {
      sessionId,
      revision: this.revision,
      prompt: text,
      recentChat: recentChatContext(this.chatTurns()),
    }
  }

  applyCatalog(catalog: SkillCatalog, error?: string): void {
    this.catalog = catalog
    this.error = error ?? ''
  }

  applySuggestions(suggestions: SkillSuggestions, enabled: boolean, sessionId: string): void {
    if (!enabled || suggestions.sessionId !== sessionId || suggestions.revision !== this.revision) return
    this.suggestions = suggestions
  }

  /** A skills file changed on disk: the next draft must be re-analyzed. */
  invalidate(): void {
    this.epoch++
    this.suggestions = undefined
  }

  clearSuggestions(): void {
    this.suggestions = undefined
  }

  clearCatalog(): void {
    this.catalog = { ...EMPTY_CATALOG }
  }

  clearOverrides(): void {
    this.overrides = { include: [], exclude: [] }
  }

  forgetKey(): void {
    this.lastAnalyzed = ''
  }

  /** A turn was accepted or a session reset: drop overrides and the pending draft. */
  resetForTurn(): void {
    this.clearOverrides()
    this.clearSuggestions()
    this.forgetKey()
  }

  /** The picker was switched off in settings. */
  disable(): void {
    this.clearOverrides()
    this.clearSuggestions()
    this.catalog = { ...EMPTY_CATALOG }
    this.error = ''
  }
}
