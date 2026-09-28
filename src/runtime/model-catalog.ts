import { isRecord, stringValue } from '../shared/value-utils.js'

export interface DiscoveredModel {
  id: string
  displayName?: string
  contextWindow?: number
  loaded?: boolean
}

export const DSH_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type DshReasoningLevel = typeof DSH_REASONING_LEVELS[number]

export const DSH_REASONING_FORMATS = [
  'openai',
  'deepseek',
  'openrouter',
  'together',
  'baseten',
  'zai',
  'qwen',
  'chat-template',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
] as const
export type DshReasoningFormat = typeof DSH_REASONING_FORMATS[number]
export type ReasoningFormat = 'auto' | DshReasoningFormat

export const REASONING_EFFORT_PRESETS = {
  'low-medium-high': ['low', 'medium', 'high'],
  'low-medium-high-xhigh': ['low', 'medium', 'high', 'xhigh'],
  'low-medium-high-max': ['low', 'medium', 'high', 'max'],
  'low-medium-high-xhigh-max': ['low', 'medium', 'high', 'xhigh', 'max'],
  'minimal-low-medium-high-xhigh-max': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'all-levels': ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
} as const satisfies Record<string, readonly DshReasoningLevel[]>
export type ReasoningEffortPreset = keyof typeof REASONING_EFFORT_PRESETS

export type BinaryThinkingMode = 'provider-default' | 'on' | 'off'
export type ChatTemplateValue = string | number | boolean | null | {
  $var: 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'
  omitWhenOff?: boolean
}

export interface PiAiModelRuntimeProfile {
  id: string
  name?: string
  contextWindow?: number
  reasoningEfforts?: Partial<Record<DshReasoningLevel, string | null>> | false
  compat?: {
    thinkingFormat?: DshReasoningFormat
    supportsReasoningEffort?: boolean
    chatTemplateKwargs?: Record<string, ChatTemplateValue>
    chatTemplateArgs?: Record<string, ChatTemplateValue>
  }
}

export interface SavedModel {
  id: string
  displayName?: string
  contextWindow?: number
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
  reasoningFormat?: ReasoningFormat
  binaryThinkingMode?: BinaryThinkingMode
  chatTemplateKwargs?: Record<string, ChatTemplateValue>
  chatTemplateArgs?: Record<string, ChatTemplateValue>
}

export interface ModelDraft extends SavedModel {
  sourceId?: string
}

export interface ActiveModelSelection {
  model: string
  contextWindow: number
}

const MODEL_CATALOG_VERSION = 1

export function parseModelCatalog(value: unknown): DiscoveredModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return []

  const models: DiscoveredModel[] = []
  for (const item of value.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === '') continue

    const task = stringValue(item.task)?.trim()
    if (task !== undefined && !['chat', 'text', 'text-generation'].includes(task)) continue

    const id = item.id.trim()
    const displayName = stringValue(item.display_name)?.trim()
    const contextWindow = positiveInteger(
      item.native_context_length ?? item.max_context_length ?? item.context_length,
    )
    const model: DiscoveredModel = { id }
    if (displayName !== undefined && displayName !== id) model.displayName = displayName
    if (contextWindow !== undefined) model.contextWindow = contextWindow
    if (typeof item.loaded === 'boolean') model.loaded = item.loaded
    models.push(model)
  }

  return models
}

export function normalizeSavedModels(value: unknown): SavedModel[] {
  if (!Array.isArray(value)) throw new Error('The models catalog must be an array.')

  const seenIds = new Set<string>()
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Model ${index + 1} must be an object.`)
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) throw new Error(`Model ${index + 1} needs a model ID.`)
    if (seenIds.has(id)) throw new Error(`Model ID "${id}" is duplicated.`)
    seenIds.add(id)

    const model: SavedModel = { id }
    if ('displayName' in entry && entry.displayName !== undefined) {
      if (typeof entry.displayName !== 'string') throw new Error(`Model "${id}" has an invalid display name.`)
      const displayName = entry.displayName.trim()
      if (displayName) model.displayName = displayName
    }
    if ('contextWindow' in entry && entry.contextWindow !== undefined) {
      const contextWindow = positiveInteger(entry.contextWindow)
      if (contextWindow === undefined) throw new Error(`Model "${id}" needs a positive whole-number context window.`)
      model.contextWindow = contextWindow
    }
    const savedReasoningEfforts = entry.reasoningEfforts
    const legacyPreset = entry.reasoningPreset
    if (legacyPreset !== undefined && !isReasoningEffortPreset(legacyPreset)) {
      throw new Error(`Model "${id}" has an unsupported reasoning effort preset.`)
    }
    if (savedReasoningEfforts !== undefined) {
      if (!Array.isArray(savedReasoningEfforts)) {
        throw new Error(`Model "${id}" needs a list of reasoning effort IDs.`)
      }
      const seenEfforts = new Set<string>()
      const reasoningEfforts = savedReasoningEfforts.map((value) => {
        const effort = typeof value === 'string' ? value.trim() : ''
        if (!effort) throw new Error(`Model "${id}" has an empty or invalid reasoning effort ID.`)
        if (seenEfforts.has(effort)) throw new Error(`Model "${id}" has a duplicate reasoning effort ID "${effort}".`)
        seenEfforts.add(effort)
        return effort
      })
      model.reasoningEfforts = reasoningEfforts
    } else if (legacyPreset !== undefined) {
      model.reasoningEfforts = [...REASONING_EFFORT_PRESETS[legacyPreset]]
    }
    if ('defaultReasoningEffort' in entry && entry.defaultReasoningEffort !== undefined) {
      if (typeof entry.defaultReasoningEffort !== 'string' || !entry.defaultReasoningEffort.trim()) {
        throw new Error(`Model "${id}" has an invalid default reasoning effort.`)
      }
      const defaultReasoningEffort = entry.defaultReasoningEffort.trim()
      if (model.reasoningEfforts === undefined || !model.reasoningEfforts.includes(defaultReasoningEffort)) {
        throw new Error(`Model "${id}" default reasoning effort must be one of its configured effort IDs.`)
      }
      model.defaultReasoningEffort = defaultReasoningEffort
    }
    if ('reasoningFormat' in entry && entry.reasoningFormat !== undefined) {
      if (!isReasoningFormat(entry.reasoningFormat)) throw new Error(`Model "${id}" has an unsupported reasoning format.`)
      model.reasoningFormat = entry.reasoningFormat
    }
    if ('binaryThinkingMode' in entry && entry.binaryThinkingMode !== undefined) {
      if (entry.binaryThinkingMode !== 'provider-default' && entry.binaryThinkingMode !== 'on' && entry.binaryThinkingMode !== 'off') {
        throw new Error(`Model "${id}" has an invalid binary thinking mode.`)
      }
      model.binaryThinkingMode = entry.binaryThinkingMode
    }
    if ('chatTemplateKwargs' in entry && entry.chatTemplateKwargs !== undefined) {
      model.chatTemplateKwargs = normalizeChatTemplateValues(entry.chatTemplateKwargs, id, 'chatTemplateKwargs')
    }
    if ('chatTemplateArgs' in entry && entry.chatTemplateArgs !== undefined) {
      model.chatTemplateArgs = normalizeChatTemplateValues(entry.chatTemplateArgs, id, 'chatTemplateArgs')
    }
    const hasGradedEffort = model.reasoningEfforts?.some((effort) => isDshReasoningLevel(effort) && effort !== 'off') ?? false
    if (model.reasoningEfforts?.includes('off') && !hasGradedEffort) {
      throw new Error(`Model "${id}" needs at least one graded reasoning effort when "off" is selected.`)
    }
    if (model.reasoningEfforts !== undefined && model.reasoningEfforts.length > 0 &&
      model.reasoningFormat !== undefined && model.reasoningFormat !== 'auto' &&
      !isBinaryReasoningFormat(model.reasoningFormat) && !hasGradedEffort) {
      throw new Error(`Model "${id}" needs a supported reasoning effort before using the "${model.reasoningFormat}" format.`)
    }
    return model
  })
}

export function resolveSavedModelReasoningEffort(
  models: SavedModel[],
  modelId: string,
  selection: string | null,
): string | undefined {
  const model = models.find((entry) => entry.id === modelId)
  if (model !== undefined && isBinaryReasoningFormat(model.reasoningFormat)) {
    const mode = model.binaryThinkingMode ?? 'provider-default'
    if (mode === 'provider-default') return undefined
    if (mode === 'off') return 'off'
    return model.reasoningEfforts?.find((effort) => effort !== 'off') ?? 'low'
  }
  if (selection === null) return model?.defaultReasoningEffort
  if (model === undefined || !model.reasoningEfforts?.includes(selection)) {
    throw new Error(`Reasoning effort "${selection}" is not configured for model "${modelId}".`)
  }
  return selection
}

export function isReasoningEffortPreset(value: unknown): value is ReasoningEffortPreset {
  return typeof value === 'string' && Object.hasOwn(REASONING_EFFORT_PRESETS, value)
}

export function isReasoningFormat(value: unknown): value is ReasoningFormat {
  return value === 'auto' || (typeof value === 'string' && (DSH_REASONING_FORMATS as readonly string[]).includes(value))
}

export function isBinaryReasoningFormat(value: ReasoningFormat | undefined): boolean {
  return value === 'qwen' || value === 'qwen-chat-template'
}

export function selectableReasoningEfforts(model: SavedModel | undefined): string[] {
  if (model === undefined || isBinaryReasoningFormat(model.reasoningFormat)) return []
  return [...(model.reasoningEfforts ?? [])]
}

export function updateReasoningEffortSelection(
  selected: readonly string[],
  defaultReasoningEffort: string | undefined,
  effort: string,
  checked: boolean,
): { reasoningEfforts: string[]; defaultReasoningEffort?: string } | undefined {
  const isKnownLevel = isDshReasoningLevel(effort)
  if (!isKnownLevel && !selected.includes(effort)) return undefined

  const next = new Set(selected)
  if (checked) next.add(effort)
  else next.delete(effort)

  const hasGradedEffort = [...next].some((value) => isDshReasoningLevel(value) && value !== 'off')
  if (checked && effort === 'off' && !hasGradedEffort) return undefined
  if (!hasGradedEffort) next.delete('off')

  const reasoningEfforts = [
    ...DSH_REASONING_LEVELS.filter((level) => next.has(level)),
    ...selected.filter((value) => !isDshReasoningLevel(value) && next.has(value)),
  ]
  const result: { reasoningEfforts: string[]; defaultReasoningEffort?: string } = { reasoningEfforts }
  if (defaultReasoningEffort !== undefined && next.has(defaultReasoningEffort)) {
    result.defaultReasoningEffort = defaultReasoningEffort
  }
  return result
}

export function piAiRuntimeModelProfiles(models: SavedModel[]): PiAiModelRuntimeProfile[] {
  return models.map((model) => {
    const profile: PiAiModelRuntimeProfile = { id: model.id }
    if (model.displayName !== undefined) profile.name = model.displayName
    if (model.contextWindow !== undefined) profile.contextWindow = model.contextWindow

    const format = model.reasoningFormat
    if (isBinaryReasoningFormat(format)) {
      const mode = model.binaryThinkingMode ?? 'provider-default'
      if (mode === 'provider-default') {
        profile.reasoningEfforts = false
      } else {
        const levels = new Set<DshReasoningLevel>(model.reasoningEfforts?.filter(isDshReasoningLevel) ?? [])
        if (![...levels].some((level) => level !== 'off')) levels.add('low')
        if (mode === 'off') levels.add('off')
        profile.reasoningEfforts = identityEffortMap([...levels])
      }
    } else if (model.reasoningEfforts !== undefined) {
      const levels = model.reasoningEfforts.filter(isDshReasoningLevel)
      if (levels.some((level) => level !== 'off')) profile.reasoningEfforts = identityEffortMap(levels)
    }

    if (format !== undefined && format !== 'auto') {
      profile.compat = { thinkingFormat: format }
      if (format === 'qwen') profile.compat.supportsReasoningEffort = false
      if (format === 'chat-template' && model.chatTemplateKwargs !== undefined) {
        profile.compat.chatTemplateKwargs = model.chatTemplateKwargs
      }
      if (format === 'baseten' && model.chatTemplateArgs !== undefined) {
        profile.compat.chatTemplateArgs = model.chatTemplateArgs
      }
    }
    return profile
  })
}

function isDshReasoningLevel(value: string): value is DshReasoningLevel {
  return (DSH_REASONING_LEVELS as readonly string[]).includes(value)
}

function identityEffortMap(levels: DshReasoningLevel[]): Partial<Record<DshReasoningLevel, string | null>> {
  const result: Partial<Record<DshReasoningLevel, string | null>> = {}
  for (const level of levels) result[level] = level === 'off' ? null : level
  return result
}

function normalizeChatTemplateValues(value: unknown, id: string, field: string): Record<string, ChatTemplateValue> {
  if (!isRecord(value)) throw new Error(`Model "${id}" ${field} must be a JSON object.`)
  const result: Record<string, ChatTemplateValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) throw new Error(`Model "${id}" ${field} has an empty key.`)
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean' || entry === null) {
      result[key] = entry
      continue
    }
    if (isRecord(entry) &&
      (entry.$var === 'thinking.enabled' || entry.$var === 'thinking.effort' || entry.$var === 'thinking.budget') &&
      Object.keys(entry).every((property) => property === '$var' || property === 'omitWhenOff') &&
      (!('omitWhenOff' in entry) || typeof entry.omitWhenOff === 'boolean')) {
      result[key] = {
        $var: entry.$var,
        ...(typeof entry.omitWhenOff === 'boolean' ? { omitWhenOff: entry.omitWhenOff } : {}),
      }
      continue
    }
    throw new Error(`Model "${id}" ${field}.${key} must be a scalar or a supported DSH $var value.`)
  }
  return result
}

export function normalizeModelDrafts(value: unknown): ModelDraft[] {
  if (!Array.isArray(value)) throw new Error('The models catalog must be an array.')

  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Model ${index + 1} must be an object.`)
    if ('sourceId' in entry && entry.sourceId !== undefined && typeof entry.sourceId !== 'string') {
      throw new Error(`Model ${index + 1} has an invalid source ID.`)
    }
    const [model] = normalizeSavedModels([entry])
    return {
      ...model,
      ...(typeof entry.sourceId === 'string' && entry.sourceId.trim() ? { sourceId: entry.sourceId.trim() } : {}),
    }
  }).reduce<ModelDraft[]>((drafts, draft) => {
    if (drafts.some((existing) => existing.id === draft.id)) {
      throw new Error(`Model ID "${draft.id}" is duplicated.`)
    }
    drafts.push(draft)
    return drafts
  }, [])
}

export function parseSavedModelCatalog(value: unknown): SavedModel[] {
  if (!isRecord(value) || value.version !== MODEL_CATALOG_VERSION) {
    throw new Error(`The models catalog must use version ${MODEL_CATALOG_VERSION}.`)
  }
  return normalizeSavedModels(value.models)
}

export function parseSavedModelCatalogJson(value: string): SavedModel[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`The models file contains invalid JSON. ${reason}`)
  }
  return parseSavedModelCatalog(parsed)
}

export function serializeSavedModelCatalog(models: unknown): string {
  const normalized = normalizeSavedModels(models)
  return `${JSON.stringify({ version: MODEL_CATALOG_VERSION, models: normalized }, null, 2)}\n`
}

export function activeSelectionAfterCatalogSave(
  previousModels: SavedModel[],
  nextModels: ModelDraft[],
  active: ActiveModelSelection,
): ActiveModelSelection | undefined {
  if (!previousModels.some((model) => model.id === active.model)) {
    const matching = nextModels.find((model) => model.id === active.model)
    if (matching === undefined) return undefined
    const matchingSelection = { model: matching.id, contextWindow: matching.contextWindow ?? 0 }
    return matchingSelection.contextWindow === active.contextWindow ? undefined : matchingSelection
  }

  const selected = nextModels.find((model) => model.sourceId === active.model) ??
    nextModels.find((model) => model.id === active.model) ??
    nextModels[0]
  if (selected === undefined) return undefined

  const nextSelection = {
    model: selected.id,
    contextWindow: selected.contextWindow ?? 0,
  }
  return nextSelection.model === active.model && nextSelection.contextWindow === active.contextWindow
    ? undefined
    : nextSelection
}

export function selectionForSavedModel(models: SavedModel[], modelId: string): ActiveModelSelection {
  const selected = models.find((model) => model.id === modelId)
  if (selected === undefined) throw new Error('The selected model is not in the saved models catalog.')
  return { model: selected.id, contextWindow: selected.contextWindow ?? 0 }
}

export function validateModelDraftSources(previousModels: SavedModel[], nextModels: ModelDraft[]): void {
  const previousIds = new Set(previousModels.map((model) => model.id))
  const sourceIds = new Set<string>()
  for (const model of nextModels) {
    if (model.sourceId === undefined) continue
    if (!previousIds.has(model.sourceId)) throw new Error(`Model "${model.sourceId}" changed since the catalog was loaded. Reload Settings before saving.`)
    if (sourceIds.has(model.sourceId)) throw new Error(`Saved model "${model.sourceId}" appears more than once.`)
    sourceIds.add(model.sourceId)
  }
}

export function modelEndpointCandidates(baseUrl: string): string[] {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (!normalized) return []
  if (normalized.endsWith('/models')) return [normalized]

  const candidates = [`${normalized}/models`]
  if (!normalized.endsWith('/v1')) candidates.push(`${normalized}/v1/models`)
  return [...new Set(candidates)]
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined
}
