export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function parsePayload(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function responseKey(data: Record<string, unknown>): string | undefined {
  return Number.isInteger(data.turn) && Number.isInteger(data.step)
    ? `${String(data.turn)}:${String(data.step)}`
    : undefined
}

export function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length
}
