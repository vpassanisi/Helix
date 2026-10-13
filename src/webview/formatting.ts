import type { SelectionMetadata } from './types.js'

export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value))
}

export function selectionLineLabel(value: SelectionMetadata): string {
  return value.ranges.map((range) => range.startLine === range.endLine
    ? `L${range.startLine}` : `L${range.startLine}–L${range.endLine}`).join(', ')
}
