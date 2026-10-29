import {
  DSH_REASONING_LEVELS,
  isBinaryReasoningFormat,
  type DshReasoningLevel,
  type ModelDraft,
  type SavedModel,
} from './model-catalog.js'

export const REASONING_EFFORT_PRESETS = {
  'low-medium-high': ['low', 'medium', 'high'],
  'low-medium-high-xhigh': ['low', 'medium', 'high', 'xhigh'],
  'low-medium-high-max': ['low', 'medium', 'high', 'max'],
  'low-medium-high-xhigh-max': ['low', 'medium', 'high', 'xhigh', 'max'],
  'minimal-low-medium-high-xhigh-max': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'all-levels': ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
} as const satisfies Record<string, readonly DshReasoningLevel[]>
export type ReasoningEffortPreset = keyof typeof REASONING_EFFORT_PRESETS

export function resolveSavedModelReasoningEffort(
  models: SavedModel[],
  modelId: string,
  selection: string | null,
  lastUsed?: string,
): string | undefined {
  const model = models.find((entry) => entry.id === modelId)
  if (model !== undefined && isBinaryReasoningFormat(model.reasoningFormat)) {
    const mode = model.binaryThinkingMode ?? 'on'
    if (mode === 'off') return 'off'
    return model.reasoningEfforts?.find((effort) => isDshReasoningLevel(effort) && effort !== 'off') ?? 'low'
  }
  if (selection === null) return preferredReasoningEffort(model, lastUsed)
  if (model === undefined || !model.reasoningEfforts?.includes(selection)) {
    throw new Error(`Reasoning effort "${selection}" is not configured for model "${modelId}".`)
  }
  return selection
}

export function preferredReasoningEffort(model: SavedModel | undefined, lastUsed?: string): string | undefined {
  if (model === undefined || isBinaryReasoningFormat(model.reasoningFormat)) return undefined
  const efforts = model.reasoningEfforts ?? []
  if (lastUsed !== undefined && efforts.includes(lastUsed)) return lastUsed
  return [...DSH_REASONING_LEVELS].reverse().find((level) => efforts.includes(level)) ?? efforts.at(-1)
}

export function reconcileReasoningEffortHistory(
  history: Record<string, string>,
  nextModels: readonly ModelDraft[],
): Record<string, string> {
  const entries: Array<[string, string]> = []
  for (const model of nextModels) {
    if (isBinaryReasoningFormat(model.reasoningFormat)) continue
    const previous = history[model.sourceId ?? model.id]
    if (previous !== undefined && model.reasoningEfforts?.includes(previous)) entries.push([model.id, previous])
  }
  return Object.fromEntries(entries)
}

export function seedReasoningEffortHistory(
  history: Record<string, string>,
  legacyDefaults: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries([
    ...Object.entries(history),
    ...Object.entries(legacyDefaults).filter(([id]) => !Object.hasOwn(history, id)),
  ])
}

export function isReasoningEffortPreset(value: unknown): value is ReasoningEffortPreset {
  return typeof value === 'string' && Object.hasOwn(REASONING_EFFORT_PRESETS, value)
}

export function selectableReasoningEfforts(model: SavedModel | undefined): string[] {
  if (model === undefined || isBinaryReasoningFormat(model.reasoningFormat)) return []
  return [...(model.reasoningEfforts ?? [])]
}

export function updateReasoningEffortSelection(
  selected: readonly string[],
  effort: string,
  checked: boolean,
): string[] | undefined {
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
  return reasoningEfforts
}

function isDshReasoningLevel(value: string): value is DshReasoningLevel {
  return (DSH_REASONING_LEVELS as readonly string[]).includes(value)
}
