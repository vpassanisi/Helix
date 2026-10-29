/**
 * The size caps for a `show_ui` spec. Kept in their own leaf module so the
 * prompt text can quote them at top level without a circular read of the
 * catalog that lists the components they cap.
 */
export const GEN_UI_LIMITS = {
  /** Serialized spec, in characters. */
  maxSpecCharacters: 16_000,
  maxElements: 80,
  maxDepth: 12,
  maxStateCharacters: 8_000,
  maxPropTextCharacters: 4_000,
  maxTableRows: 60,
  maxColumns: 8,
  /** A Grid wider than this is an unreadable sliver in a sidebar. */
  maxGridColumns: 3,
} as const
