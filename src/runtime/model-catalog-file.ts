import { isRecord } from '../shared/value-utils.js'
import { isBinaryReasoningFormat, normalizeSavedModels, type SavedModel } from './model-catalog.js'

export const MODEL_CATALOG_VERSION = 1

export function parseSavedModelCatalog(value: unknown): SavedModel[] {
  if (!isRecord(value) || value.version !== MODEL_CATALOG_VERSION) {
    throw new Error(`The models catalog must use version ${MODEL_CATALOG_VERSION}.`)
  }
  return normalizeSavedModels(value.models)
}

export function parseSavedModelCatalogJson(value: string): SavedModel[] {
  return parseSavedModelCatalogJsonWithLegacy(value).models
}

export function parseSavedModelCatalogJsonWithLegacy(value: string): {
  models: SavedModel[]
  legacyDefaults: Record<string, string>
  needsMigration: boolean
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`The models file contains invalid JSON. ${reason}`)
  }
  const models = parseSavedModelCatalog(parsed)
  const entries = (parsed as { models: unknown[] }).models
  const legacyEntries: Array<[string, string]> = []
  let needsMigration = false
  for (const [index, model] of models.entries()) {
    const entry = entries[index] as Record<string, unknown>
    if (typeof entry.defaultReasoningEffort === 'string') {
      needsMigration = true
      if (!isBinaryReasoningFormat(model.reasoningFormat)) {
        legacyEntries.push([model.id, entry.defaultReasoningEffort.trim()])
      }
    }
    if (entry.binaryThinkingMode === 'provider-default' ||
      (isBinaryReasoningFormat(model.reasoningFormat) && entry.binaryThinkingMode === undefined)) {
      needsMigration = true
    }
  }
  return { models, legacyDefaults: Object.fromEntries(legacyEntries), needsMigration }
}

export function serializeSavedModelCatalog(models: unknown): string {
  const normalized = normalizeSavedModels(models)
  return `${JSON.stringify({ version: MODEL_CATALOG_VERSION, models: normalized }, null, 2)}\n`
}
