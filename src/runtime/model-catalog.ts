export interface DiscoveredModel {
  id: string
  displayName?: string
  contextWindow?: number
  loaded?: boolean
}

export function parseModelCatalog(value: unknown): DiscoveredModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return []

  const models: DiscoveredModel[] = []
  for (const item of value.data) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === '') continue

    const task = stringValue(item.task)
    if (task !== undefined && !['chat', 'text', 'text-generation'].includes(task)) continue

    const id = item.id.trim()
    const displayName = stringValue(item.display_name)
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
