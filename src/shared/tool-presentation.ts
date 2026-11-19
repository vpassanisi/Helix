import { isRecord } from './value-utils.js'

/**
 * The tool card's own words.
 *
 * A DSH tool can describe its own calls: `ToolDefinition.presentCall` returns a
 * provider-neutral view (`card: 'generic' | 'terminal' | 'diff' | ...`) whose
 * `title` says what the call does, whose `kind` picks an icon, and whose
 * `locations` name the files it touches. The read tool uses it for
 * `Read src/a.ts (30 - 60)`, and bash uses it to place the model's own
 * `description` above a terminal card.
 *
 * Helix is not a DSH client, so nothing calls those presenters for us. The
 * runtime-side bridge calls them through the tool registry and projects the
 * result into the narrow shape below, which is the only form that crosses the
 * wire. Content blocks, diffs, and file lines stay behind: they are large, and
 * the Webview has no card that renders them yet.
 */
export type ToolPresentationCard = 'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web'

/** The category a tool declares for one call; it picks the card's icon. */
export type ToolPresentationKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

/** One file a call touches, so the card can open it in the editor. */
export interface ToolPresentationLocation {
  path: string
  line?: number
}

export interface ToolPresentation {
  card: ToolPresentationCard
  /** The call's own label, authored by the tool. */
  title?: string
  /** A one-line summary above the card, when the tool has one. */
  description?: string
  kind?: ToolPresentationKind
  locations?: ToolPresentationLocation[]
  /** Working directory, for a call that is a shell command. */
  cwd?: string
}

const PRESENTATION_CARDS: readonly ToolPresentationCard[] = ['generic', 'terminal', 'diff', 'search', 'read', 'web']
const PRESENTATION_KINDS: readonly ToolPresentationKind[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other']

/**
 * The category a card shape implies, used only when the presenter leaves
 * `kind` out. A diff card is a file change, a terminal card is a command, and a
 * search card is a discovery run, so each one has an obvious icon. A card that
 * implies nothing, which is `generic`, keeps the tool card's default.
 */
const CARD_IMPLIED_KIND: Partial<Record<ToolPresentationCard, ToolPresentationKind>> = {
  diff: 'edit',
  terminal: 'execute',
  search: 'search',
  read: 'read',
}

/** A tool writes one short label, so anything longer is a runaway string. */
export const TOOL_PRESENTATION_LABEL_CHARACTERS = 240
export const TOOL_PRESENTATION_LOCATION_LIMIT = 4
export const TOOL_PRESENTATION_PATH_CHARACTERS = 500

function label(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > TOOL_PRESENTATION_LABEL_CHARACTERS ? `${trimmed.slice(0, TOOL_PRESENTATION_LABEL_CHARACTERS)}…` : trimmed
}

function path(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > TOOL_PRESENTATION_PATH_CHARACTERS ? `${trimmed.slice(0, TOOL_PRESENTATION_PATH_CHARACTERS)}…` : trimmed
}

function locations(value: unknown): ToolPresentationLocation[] | undefined {
  if (!Array.isArray(value)) return undefined
  const picked = value.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const file = path(entry.path)
    if (file === undefined) return []
    const line = typeof entry.line === 'number' && Number.isSafeInteger(entry.line) && entry.line > 0 ? entry.line : undefined
    return [{ path: file, ...(line === undefined ? {} : { line }) }]
  }).slice(0, TOOL_PRESENTATION_LOCATION_LIMIT)
  return picked.length > 0 ? picked : undefined
}

/**
 * Narrow one presenter's return value to the wire shape.
 *
 * Presenters are documented pure and side-effect-free, and the registry hands
 * them frozen arguments, so a value outside this shape is a tool defect. This
 * function never throws: an unusable view becomes `undefined`, and the card
 * falls back to the tool name plus its raw arguments.
 */
export function projectToolPresentation(view: unknown): ToolPresentation | undefined {
  if (!isRecord(view)) return undefined
  const card = PRESENTATION_CARDS.find((entry) => entry === view.card)
  if (card === undefined) return undefined
  const title = label(view.title)
  const description = label(view.description)
  const kind = PRESENTATION_KINDS.find((entry) => entry === view.kind) ?? CARD_IMPLIED_KIND[card]
  const files = locations(view.locations)
  const cwd = path(view.cwd)
  if (title === undefined && description === undefined && files === undefined) return undefined

  return {
    card,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(kind === undefined ? {} : { kind }),
    ...(files === undefined ? {} : { locations: files }),
    ...(cwd === undefined ? {} : { cwd }),
  }
}

/** The wire validator for a projected view: the same field checks, from the other side. */
export function isToolPresentation(value: unknown): value is ToolPresentation {
  if (!isRecord(value)) return false
  if (!PRESENTATION_CARDS.some((card) => card === value.card)) return false
  if ('title' in value && typeof value.title !== 'string') return false
  if ('description' in value && typeof value.description !== 'string') return false
  if ('kind' in value && !PRESENTATION_KINDS.some((kind) => kind === value.kind)) return false
  if ('cwd' in value && typeof value.cwd !== 'string') return false
  if ('locations' in value && (!Array.isArray(value.locations) ||
    !value.locations.every((entry) => isRecord(entry) && typeof entry.path === 'string' &&
      (!('line' in entry) || (typeof entry.line === 'number' && Number.isSafeInteger(entry.line)))))) return false
  return true
}

/**
 * The line shown under the tool name: the tool's own summary when it has one,
 * else its own title, else the description argument the model wrote.
 *
 * A terminal card titles itself with the command, which the Arguments pane
 * already prints, so the summary above it reads better than the command.
 */
export function toolPresentationLine(presentation: ToolPresentation | undefined): string | undefined {
  if (presentation === undefined) return undefined
  return presentation.description ?? presentation.title
}
