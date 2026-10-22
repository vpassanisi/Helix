import { preferredReasoningEffort, selectableReasoningEfforts } from '../../runtime/model-catalog.js'
import { contextUsageTotal, numericValue } from '../../shared/harness-events.js'
import type { SidebarModel, SidebarSettings } from '../types.js'

/**
 * What the composer shows for the active model: the reasoning effort the next
 * request will send, and the context window the meter draws.
 */
export class ComposerModelState {
  model = $state('')
  reasoningEffort = $state<string | null>(null)
  reasoningHistory = $state<Record<string, string>>({})
  contextUsed = $state<number | undefined>()
  contextWindow = $state<number | undefined>()
  contextWindowOverride = $state<number | undefined>()
  changing = $state(false)
  private effortNeedsCatalog = false

  constructor(private readonly findModel: (modelId: string) => SidebarModel | undefined) {}

  efforts(modelId: string): string[] {
    return selectableReasoningEfforts(this.findModel(modelId))
  }

  preferredEffort(modelId: string): string | null {
    return preferredReasoningEffort(this.findModel(modelId), this.reasoningHistory[modelId]) ?? null
  }

  selectEffort(value: string): void {
    if (this.efforts(this.model).includes(value)) this.reasoningEffort = value
  }

  /** A pick from the composer: the model changes straight away, the host follows. */
  select(modelId: string): void {
    const selected = this.findModel(modelId)
    this.model = modelId
    this.reasoningEffort = this.preferredEffort(modelId)
    this.effortNeedsCatalog = false
    this.contextWindowOverride = selected?.contextWindow
    this.contextWindow = selected?.contextWindow
    this.changing = true
  }

  applyReasoningHistory(history: Record<string, string>): void {
    this.reasoningHistory = history
  }

  applyRuntimeEffort(effort: string | undefined): void {
    this.reasoningEffort = effort ?? this.preferredEffort(this.model)
    this.effortNeedsCatalog = effort === undefined && this.findModel(this.model) === undefined
  }

  applyModelChanged(modelId: string, effort: string | undefined): void {
    if (effort !== undefined && this.efforts(modelId).includes(effort)) {
      this.reasoningHistory = { ...this.reasoningHistory, [modelId]: effort }
    }
    if (this.model === modelId) this.reasoningEffort = effort ?? null
    this.effortNeedsCatalog = false
  }

  applySettings(next: SidebarSettings): void {
    if (this.model !== next.model) {
      this.model = next.model
      this.reasoningEffort = this.preferredEffort(next.model)
      this.effortNeedsCatalog = this.findModel(next.model) === undefined
    }
    const selected = this.findModel(next.model)
    this.contextWindowOverride = selected?.contextWindow ?? (next.contextWindow > 0 ? next.contextWindow : undefined)
    this.contextWindow = this.contextWindowOverride
  }

  applyCatalogContextWindow(): void {
    const selected = this.findModel(this.model)
    if (selected?.contextWindow === undefined) return
    this.contextWindowOverride = selected.contextWindow
    this.contextWindow = selected.contextWindow
  }

  syncEffortWithCatalog(): void {
    const selected = this.findModel(this.model)
    if (this.effortNeedsCatalog) {
      this.reasoningEffort = this.preferredEffort(this.model)
      this.effortNeedsCatalog = false
    } else if (this.reasoningEffort !== null && !selected?.reasoningEfforts?.includes(this.reasoningEffort)) {
      this.reasoningEffort = this.preferredEffort(this.model)
    } else if (this.reasoningEffort === null && this.efforts(this.model).length > 0) {
      this.reasoningEffort = this.preferredEffort(this.model)
    }
  }

  /** A fresh session keeps the window, drops the usage reading. */
  resetForSession(): void {
    this.contextUsed = undefined
    this.contextWindow = this.contextWindowOverride
  }

  updateContextWindow(value: unknown): void {
    const selected = this.findModel(this.model)
    if (selected?.contextWindow !== undefined) {
      this.contextWindow = selected.contextWindow
      return
    }
    if (this.contextWindowOverride !== undefined) {
      this.contextWindow = this.contextWindowOverride
      return
    }
    const next = numericValue(value)
    if (next !== undefined && next > 0) this.contextWindow = next
  }

  recordUsage(value: unknown): void {
    const total = contextUsageTotal(value)
    if (total !== undefined) this.contextUsed = total
  }

  clearUsage(): void {
    this.contextUsed = undefined
  }
}
