import { discoveredToEditorDraft, toModelDraft, toModelEditorDraft } from './model-mappers.js'
import type { ModelEditorDraft, SidebarDiscoveredModel, SidebarMessage, SidebarModel } from '../types.js'

/** The model catalog page: saved models, the editable drafts, and the discovery list. */
export class ModelCatalogState {
  models = $state<SidebarModel[]>([])
  discovered = $state<SidebarDiscoveredModel[]>([])
  drafts = $state<ModelEditorDraft[]>([])
  loading = $state(false)
  error = $state('')
  catalogLoading = $state(true)
  catalogSaving = $state(false)
  catalogError = $state('')
  private nextDraftKey = 1

  find(modelId: string): SidebarModel | undefined {
    return this.models.find((entry) => entry.id === modelId)
  }

  beginLoad(): void {
    this.loading = true
    this.error = ''
    this.catalogLoading = true
    this.catalogError = ''
    this.discovered = []
  }

  beginRefresh(): void {
    this.loading = true
    this.error = ''
  }

  applyCatalog(models: SidebarModel[], error?: string): void {
    this.models = models
    this.drafts = this.editorDrafts(models)
    this.catalogLoading = false
    this.catalogError = error ?? ''
  }

  applySaved(models: SidebarModel[]): void {
    this.models = models
    this.drafts = this.editorDrafts(models)
    this.catalogSaving = false
    this.catalogError = ''
  }

  applyDiscovered(models: SidebarDiscoveredModel[], error?: string): void {
    this.discovered = models
    this.loading = false
    this.error = error ?? ''
  }

  /** Called when the page closes: unsaved edits are dropped for the saved catalog. */
  resetDrafts(): void {
    this.drafts = this.editorDrafts(this.models)
  }

  addDiscovered(modelId: string): { outcome: 'added' | 'exists' | 'unknown'; label: string } {
    const discovered = this.discovered.find((entry) => entry.id === modelId)
    if (discovered === undefined) return { outcome: 'unknown', label: modelId }
    const existing = this.drafts.find((entry) => entry.id === discovered.id)
    if (existing !== undefined) return { outcome: 'exists', label: existing.displayName || existing.id }
    this.drafts = [discoveredToEditorDraft(discovered, this.nextDraftKey++), ...this.drafts]
    return { outcome: 'added', label: discovered.displayName ?? discovered.id }
  }

  beginSave(): void {
    this.catalogSaving = true
  }

  saveRejected(): void {
    this.catalogSaving = false
  }

  buildSaveMessage(): Extract<SidebarMessage, { type: 'saveModelCatalog' }> {
    return { type: 'saveModelCatalog', models: this.drafts.map(toModelDraft) }
  }

  private editorDrafts(models: SidebarModel[]): ModelEditorDraft[] {
    return models.map((entry) => toModelEditorDraft(entry, this.nextDraftKey++))
  }
}
