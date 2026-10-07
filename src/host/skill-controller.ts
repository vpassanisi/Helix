import { createHash } from 'node:crypto'
import { decideSkills, type DecisionConnection } from './decision-client.js'
import { decisionEndpoint, effectiveSkills, recentChatContext, type SkillCatalog, type SkillDraft, type SkillOverrides, type SkillSuggestions, type SkillTurnSelection } from '../shared/skills.js'

interface Analysis {
  draft: SkillDraft
  abort: AbortController
  timer?: ReturnType<typeof setTimeout>
  done?: Promise<void>
  key?: string
  probabilities: Record<string, number>
  selected: string[]
  status: SkillSuggestions['status']
  message?: string
  threshold?: number
  startedAt?: number
  frozen: boolean
  settled: boolean
}
export interface SkillControllerOptions {
  catalog: (sessionId: string) => Promise<SkillCatalog>
  connection: () => Promise<DecisionConnection>
  metadata: () => string
  currentSession: () => string
  publish: (value: SkillSuggestions) => void
  publishCatalog: (sessionId: string, catalog: SkillCatalog) => void
  decide?: typeof decideSkills
  debounceMs?: number
  timeoutMs?: number
  sendTimeoutMs?: number
  diagnostic?: (event: { sessionId: string; revision: number; phase: string; elapsedMs: number; details: Record<string, unknown> }) => void
}

export class SkillController {
  private active?: Analysis
  private catalogGeneration = 0
  private cached?: { key: string; probabilities: Record<string, number>; selected: string[]; status: SkillSuggestions['status'] }
  constructor(private readonly options: SkillControllerOptions) {}

  async loadCatalog(sessionId: string): Promise<void> {
    const generation = ++this.catalogGeneration
    try {
      const catalog = await this.options.catalog(sessionId)
      if (generation === this.catalogGeneration && sessionId === this.options.currentSession()) this.options.publishCatalog(sessionId, catalog)
    } catch (error) {
      if (generation === this.catalogGeneration && sessionId === this.options.currentSession()) throw error
    }
  }

  update(draft: SkillDraft): void {
    if (draft.sessionId !== this.options.currentSession()) return
    if (this.active?.frozen) return
    if (this.active && draft.revision <= this.active.draft.revision) return
    this.cancel()
    const analysis = this.create(draft)
    this.active = analysis
    if (!draft.prompt.trim()) { analysis.status = 'disabled'; this.publish(analysis); return }
    this.publish(analysis)
    analysis.timer = setTimeout(() => { analysis.timer = undefined; this.start(analysis) }, this.options.debounceMs ?? 500)
  }

  private create(draft: SkillDraft): Analysis {
    return { draft: { ...draft, recentChat: recentChatContext(draft.recentChat) }, abort: new AbortController(), probabilities: {}, selected: [], status: 'checking', frozen: false, settled: false }
  }
  private start(analysis: Analysis): Promise<void> {
    if (analysis.timer) { clearTimeout(analysis.timer); analysis.timer = undefined }
    analysis.done ??= this.run(analysis)
    return analysis.done
  }
  private result(analysis: Analysis): SkillSuggestions {
    return { sessionId: analysis.draft.sessionId, revision: analysis.draft.revision,
      selected: [...analysis.selected], probabilities: { ...analysis.probabilities }, status: analysis.status,
      ...(analysis.threshold !== undefined ? { threshold: analysis.threshold } : {}),
      ...(analysis.startedAt !== undefined ? { elapsedMs: Date.now() - analysis.startedAt } : {}),
      ...(analysis.message ? { message: analysis.message } : {}) }
  }
  private trace(analysis: Analysis, phase: string, details: Record<string, unknown> = {}): void {
    try {
      this.options.diagnostic?.({ sessionId: analysis.draft.sessionId, revision: analysis.draft.revision, phase,
        elapsedMs: analysis.startedAt === undefined ? 0 : Date.now() - analysis.startedAt, details })
    } catch { /* Diagnostics must not affect routing. */ }
  }
  private publish(analysis: Analysis): void {
    if (this.active !== analysis || analysis.abort.signal.aborted || analysis.draft.sessionId !== this.options.currentSession()) return
    this.options.publish(this.result(analysis))
  }
  private async run(analysis: Analysis): Promise<void> {
    analysis.startedAt = Date.now()
    const timeoutMs = this.options.timeoutMs ?? 30_000
    const timer = setTimeout(() => analysis.abort.abort(new Error(`Skill selection timed out after ${timeoutMs / 1000} seconds.`)), timeoutMs)
    try {
      const [connection, catalog] = await abortable(Promise.all([this.options.connection(), this.options.catalog(analysis.draft.sessionId)]), analysis.abort.signal)
      if (analysis.abort.signal.aborted || this.active !== analysis) return
      this.options.publishCatalog(analysis.draft.sessionId, catalog)
      if (!connection.enabled || !analysis.draft.prompt.trim()) { analysis.status = 'disabled'; return }
      if (!catalog.complete) throw new Error('Skill discovery is incomplete.')
      analysis.threshold = connection.threshold
      const input = JSON.stringify({ currentDraft: analysis.draft.prompt, recentChat: analysis.draft.recentChat, workspace: this.options.metadata() })
      const key = createHash('sha256').update(JSON.stringify({ input, catalog, connection })).digest('hex')
      analysis.key = key
      this.trace(analysis, 'started', { endpoint: decisionEndpoint(connection.baseUrl, connection.format), format: connection.format,
        model: connection.model, threshold: connection.threshold, timeoutMs, promptCharacters: analysis.draft.prompt.length,
        contextCharacters: input.length, catalogRevision: catalog.revision, skills: catalog.skills })
      if (this.cached?.key === key) {
        Object.assign(analysis, { probabilities: { ...this.cached.probabilities }, selected: [...this.cached.selected], status: this.cached.status })
        this.trace(analysis, 'cache-hit')
        return
      }
      const candidates = catalog.skills.filter((skill) => skill.modelInvocable)
      const batches = Array.from({ length: Math.ceil(candidates.length / 32) }, (_, i) => candidates.slice(i * 32, (i + 1) * 32))
      let next = 0
      let unavailable = false
      const worker = async () => {
        while (next < batches.length && !analysis.abort.signal.aborted) {
          const batch = batches[next++]!
          try {
            const answers = await (this.options.decide ?? decideSkills)(connection, input, batch, analysis.abort.signal)
            if (analysis.abort.signal.aborted || analysis.settled || this.active !== analysis) { this.trace(analysis, 'ignored-response'); return }
            this.trace(analysis, 'answers', { answers })
            for (const answer of answers) {
              if (answer.probability === undefined) {
                unavailable = true
                analysis.message ??= 'The decisions endpoint returned missing, refused, or invalid answers.'
                continue
              }
              analysis.probabilities[answer.skillId] = answer.probability
            }
            analysis.selected = candidates.filter((skill) => (analysis.probabilities[skill.name] ?? -1) >= connection.threshold).map((skill) => skill.name)
            this.publish(analysis)
          } catch (error) {
            unavailable = true
            analysis.message ??= error instanceof Error ? error.message : String(error)
            this.trace(analysis, 'batch-failed', { message: analysis.message })
          }
        }
      }
      await abortable(Promise.all([worker(), worker()]), analysis.abort.signal)
      analysis.status = unavailable || analysis.abort.signal.aborted ? 'unavailable' : 'ready'
      if (!analysis.abort.signal.aborted && !unavailable) this.cached = { key, probabilities: { ...analysis.probabilities }, selected: [...analysis.selected], status: analysis.status }
    } catch (error) {
      analysis.status = 'unavailable'
      analysis.message ??= error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
      if (analysis.abort.signal.aborted) analysis.status = 'unavailable'
      analysis.settled = true
      this.trace(analysis, 'finished', { status: analysis.status, probabilities: { ...analysis.probabilities },
        selected: [...analysis.selected], threshold: analysis.threshold, message: analysis.message,
        current: this.active === analysis, frozen: analysis.frozen })
      // Timeout is reported for the current draft, but obsolete drafts never publish.
      if (this.active === analysis && analysis.draft.sessionId === this.options.currentSession() && !analysis.frozen) {
        this.options.publish(this.result(analysis))
      }
    }
  }

  async freeze(draft: SkillDraft, overrides: SkillOverrides): Promise<SkillTurnSelection> {
    let analysis = this.active
    if (!analysis || JSON.stringify(analysis.draft) !== JSON.stringify(draft)) {
      this.cancel()
      analysis = this.create(draft)
      this.active = analysis
    }
    analysis.frozen = true
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.start(analysis), new Promise<void>((resolve) => { timeout = setTimeout(resolve, this.options.sendTimeoutMs ?? 2000) })])
    clearTimeout(timeout)
    analysis.settled = true
    const selection = { include: effectiveSkills(this.active === analysis ? analysis.selected : [], overrides), exclude: [...overrides.exclude], manual: [...overrides.include], prompt: draft.prompt }
    this.trace(analysis, 'submitted', { include: selection.include, exclude: selection.exclude, manual: selection.manual })
    analysis.abort.abort()
    return selection
  }

  cancel(): void {
    if (this.active?.timer) clearTimeout(this.active.timer)
    this.active?.abort.abort()
    this.active = undefined
  }
  invalidate(): void { this.cancel(); this.cached = undefined; ++this.catalogGeneration }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Skill selection was cancelled.'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
