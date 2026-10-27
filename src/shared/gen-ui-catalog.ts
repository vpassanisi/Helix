import { defineCatalog, validateSpec } from '@json-render/core'
import { schema } from '@json-render/svelte/schema'
import { z } from 'zod'

/**
 * json-render's expression forms. A prop may be a literal **or** one of these,
 * which is why every prop in the catalog below runs through `dyn`: a literal
 * schema alone would reject the state bindings that make a card interactive,
 * and the point of validating is to catch the literals that are wrong.
 */
const GEN_UI_EXPRESSIONS = z.union([
  z.object({ $state: z.string() }),
  z.object({ $bindState: z.string() }),
  z.object({ $bindItem: z.string() }),
  z.object({ $item: z.string() }),
  z.object({ $index: z.boolean() }),
  z.object({ $template: z.string() }),
  z.object({ $computed: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  z.object({ $cond: z.unknown(), $then: z.unknown(), $else: z.unknown() }),
])

function dyn<T extends z.ZodTypeAny>(literal: T) {
  return z.union([literal, GEN_UI_EXPRESSIONS])
}

/**
 * The component and action surface an agent may draw with through `show_ui`.
 *
 * One catalog, three consumers: the DSH-side plugin (system-prompt section and
 * the gate in front of a tool call), the extension host (validation of what
 * arrives), and the Webview (the registry that renders it). A type only
 * renders when it is listed here, so the list is also the security boundary:
 * the model cannot name markup, scripts, or styles.
 */
export const helixGenUiCatalog = defineCatalog(schema, {
  components: {
    Stack: {
      props: z.object({
        direction: dyn(z.enum(['vertical', 'horizontal'])).optional(),
        gap: dyn(z.enum(['none', 'sm', 'md', 'lg'])).optional(),
        align: dyn(z.enum(['start', 'center', 'end', 'stretch'])).optional(),
      }),
      slots: ['default'],
      description: 'Stacks children vertically or horizontally.',
    },
    Grid: {
      props: z.object({
        columns: dyn(z.number()),
        gap: dyn(z.enum(['none', 'sm', 'md', 'lg'])).optional(),
      }),
      slots: ['default'],
      description: 'Fixed-column grid for dashboards; the sidebar is narrow.',
    },
    Card: {
      props: z.object({
        title: dyn(z.string()).optional(),
        subtitle: dyn(z.string()).optional(),
        tone: dyn(z.enum(['default', 'accent', 'danger'])).optional(),
      }),
      slots: ['default'],
      description: 'Grouping surface: title, subtitle, tone.',
    },
    Heading: {
      props: z.object({
        text: dyn(z.string()),
        level: dyn(z.enum(['h1', 'h2', 'h3'])).optional(),
      }),
      slots: [],
      description: 'Section title, a few words. One per card at most.',
    },
    Text: {
      props: z.object({
        text: dyn(z.string()),
        tone: dyn(z.enum(['default', 'muted', 'strong'])).optional(),
        size: dyn(z.enum(['sm', 'md'])).optional(),
      }),
      slots: [],
      description: 'One short line of plain text: a label or caption, never a paragraph. No markup, no code fence.',
    },
    Separator: {
      props: z.object({
        spacing: dyn(z.enum(['sm', 'md', 'lg'])).optional(),
      }),
      slots: [],
      description: 'Horizontal rule between sections.',
    },
    Badge: {
      props: z.object({
        label: dyn(z.string()),
        tone: dyn(z.enum(['neutral', 'info', 'success', 'warning', 'danger'])).optional(),
      }),
      slots: [],
      description: 'Compact status or category label.',
    },
    Alert: {
      props: z.object({
        text: dyn(z.string()),
        title: dyn(z.string()).optional(),
        tone: dyn(z.enum(['info', 'success', 'warning', 'danger'])).optional(),
      }),
      slots: [],
      description: 'One inline status line with a tone. Not a report.',
    },
    Table: {
      props: z.object({
        caption: dyn(z.string()).optional(),
        columns: dyn(z.array(z.string())),
        rows: dyn(z.array(z.array(z.string()))),
      }),
      slots: [],
      description: 'Rows of data: header labels plus cell arrays, every row the length of columns. Cells are short values, not sentences.',
    },
    Metric: {
      props: z.object({
        label: dyn(z.string()),
        value: dyn(z.string()),
        delta: dyn(z.string()).optional(),
        tone: dyn(z.enum(['default', 'success', 'danger'])).optional(),
      }),
      slots: [],
      description: 'Headline number with a label and an optional change.',
    },
    Progress: {
      props: z.object({
        label: dyn(z.string()),
        value: dyn(z.number()),
        max: dyn(z.number()).optional(),
        showValue: dyn(z.boolean()).optional(),
      }),
      slots: [],
      description: 'Progress bar. value and max are plain numbers.',
    },
    CodeBlock: {
      props: z.object({
        code: dyn(z.string()),
        language: dyn(z.string()).optional(),
      }),
      slots: [],
      description: 'Monospace block for a snippet, command, or diff. No line numbers.',
    },
    List: {
      props: z.object({
        ordered: dyn(z.boolean()).optional(),
      }),
      slots: ['default'],
      description: 'List container whose children are ListItem elements.',
    },
    ListItem: {
      props: z.object({
        text: dyn(z.string()),
        note: dyn(z.string()).optional(),
        tone: dyn(z.enum(['default', 'muted', 'danger'])).optional(),
      }),
      slots: [],
      description: 'One row in a List, with an optional muted note.',
    },
    Button: {
      props: z.object({
        label: dyn(z.string()),
        variant: dyn(z.enum(['primary', 'secondary', 'danger'])).optional(),
        disabled: dyn(z.boolean()).optional(),
      }),
      slots: [],
      description: "Action button. Bind its press event with on.press to one of the catalog actions.",
    },
    TextInput: {
      props: z.object({
        label: dyn(z.string()),
        value: dyn(z.string()).optional(),
        placeholder: dyn(z.string()).optional(),
      }),
      slots: [],
      description: "Labelled single-line input. Bind it to state with props.value = {\"$bindState\": \"/form/field\"}.",
    },
    SelectInput: {
      props: z.object({
        label: dyn(z.string()).optional(),
        options: dyn(z.array(z.string())),
        value: dyn(z.string()).optional(),
      }),
      slots: [],
      description: 'Native select over a fixed option list. Bind value with $bindState.',
    },
    Checkbox: {
      props: z.object({
        label: dyn(z.string()),
        checked: dyn(z.boolean()).optional(),
      }),
      slots: [],
      description: 'Single checkbox. Bind checked with $bindState.',
    },
  },
  actions: {
    prompt: {
      params: z.object({ text: dyn(z.string()) }),
      description: 'Start a new chat turn with this text, as if the user typed it.',
    },
    inject: {
      params: z.object({ text: dyn(z.string()) }),
      description: 'Add this text to the turn that is running right now.',
    },
    openPath: {
      params: z.object({ path: dyn(z.string()), label: dyn(z.string()).optional() }),
      description: 'Open a workspace file in the editor. path must be an absolute path inside the workspace.',
    },
    openLink: {
      params: z.object({ url: dyn(z.string()), label: dyn(z.string()).optional() }),
      description: 'Open an http(s) link in the user\u2019s browser.',
    },
    copy: {
      params: z.object({ text: dyn(z.string()) }),
      description: 'Copy text to the clipboard.',
    },
    dismiss: {
      params: z.object({}),
      description: 'Mark this card dismissed, dimming it without deleting it.',
    },
  },
})

/**
 * One-line prop notes for the prompt, keyed by component. The catalog carries
 * what the model must satisfy; these say what it is easy to get wrong, which
 * zod descriptions cannot say in the prop list. A test keeps these keys in
 * step with `componentNames`.
 */
export const HELIX_GEN_UI_PROP_HINTS: Record<string, string> = {
  Stack: 'direction: vertical | horizontal; gap: none | sm | md | lg; align: start | center | end | stretch',
  Grid: 'columns: 1-3 (more is refused); gap: none | sm | md | lg',
  Card: 'title?, subtitle?, tone: default | accent | danger',
  Heading: 'text: a few words; level: h1 | h2 | h3',
  Text: 'text: one short line; tone: default | muted | strong; size: sm | md',
  Separator: 'spacing?: sm | md | lg (defaults to sm)',
  Badge: 'label; tone: neutral | info | success | warning | danger',
  Alert: 'text: one line; title?; tone: info | success | warning | danger',
  Table: 'columns: string[]; rows: string[][] (every row the length of columns); caption?',
  Metric: 'label, value (string); delta?; tone: default | success | danger',
  Progress: 'label, value, max (numbers), showValue?',
  CodeBlock: 'code; language? (label only)',
  List: 'ordered?; children must be ListItem',
  ListItem: 'text: a few words; note?; tone: default | muted | danger',
  Button: 'label; variant: primary | secondary | danger; disabled?; fires on.press',
  TextInput: 'label; value (use {"$bindState":"/form/…"}); placeholder?',
  SelectInput: 'options: string[]; label?; value (use $bindState)',
  Checkbox: 'label; checked (use $bindState)',
}

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

export const GEN_UI_TOOL_NAME = 'show_ui'

const GEN_UI_SPEC_RULES = [
  'The spec is one JSON object: { root: "<element key>", elements: { "<key>": { type, props, children, on?, visible?, repeat? } }, state? }.',
  'Every element needs a "children" array, and every key it lists must exist in "elements". A missing child makes a whole branch disappear.',
  '"on", "visible" and "repeat" sit on the element object, never inside "props".',
  'Bind an event to an action as: "on": { "press": { "action": "prompt", "params": { "text": "Run the migration" } } }.',
  'A binding only fires on a component that fires events, and today that is the Button alone. An "on" on a Card, Stack, Table cell or Text does nothing.',
  'For interactivity inside the card, put seed data in "state" and reach it with {"$state":"/path"}, {"$bindState":"/path"}, {"$template":"Sent: ${/form/note}"} (a button reads state back through $template), and the built-in setState action.',
  'Keep every string prop as plain text. Never emit HTML, markdown, emoji runs, colours, CSS, or URLs as props.',
]

/**
 * A card does two jobs: it lays data out where a reader can scan it, or it is a
 * surface the reader acts on. It is not a place to write. Agents reach for
 * `show_ui` readily, which is the point, and then fill the card with the answer
 * itself, so the rule is stated as a shape test: a good card is scanned in a
 * second, a bad card has to be read.
 */
const GEN_UI_USE_FOR = [
  'Two jobs, nothing else: lay out data (metrics, tables, progress, comparisons, statuses, a diff), or build an interactive surface (a form, a picker, a checklist, buttons that send the next step back).',
  'The card is the shape of the answer, not the answer. Explanation, findings and reasoning go in the text before the call, never after it.',
  'A good card is scanned in a second: labels, numbers, states, options. A bad card has to be read: paragraphs, notes, full sentences.',
]

const GEN_UI_NOT_FOR = [
  'Never write an essay into a card: no summary, no walkthrough, no list of findings. If the spec reads as prose, answer in text and render only what is structured.',
  'No markdown in a card. Text, Heading, Alert, ListItem and table cells take plain fragments: no bullets, links, bold, headings, code fences, emoji runs.',
  'Do not put sentences in Table cells or List items, and do not rebuild prose as a List. Long content goes in chat text, or into a file the card opens with openPath.',
]

const GEN_UI_TEXT_BUDGET = [
  'Per card: one Heading, two Text lines, one Alert, at most. Each a single short line.',
  'Make data and controls most of the elements: Metric, Table, Progress, Badge, Grid, CodeBlock, Button, inputs.',
  'Labels, titles, notes, cells, button labels: a few words. No line over ~120 characters, no paragraph anywhere.',
  'If the content will not fit that budget, it is prose: keep it in your reply and put the structure on the card.',
]

const GEN_UI_MECHANICS = [
  `Call \`${GEN_UI_TOOL_NAME}\` for a card, one per turn, one subject per card. Not for a greeting or a one-sentence answer.`,
  `The \`${GEN_UI_TOOL_NAME}\` call is the response, not a prelude to one. Say everything you have to say before it and end the turn there: no paragraph, summary, list of findings or closing question after a card.`,
  'Do not restate the card in text. One short sentence before the call is enough.',
  `Stay under ${GEN_UI_LIMITS.maxElements} elements, ${GEN_UI_LIMITS.maxSpecCharacters / 1000}k characters of JSON and ${GEN_UI_LIMITS.maxDepth} levels of nesting; tables cap at ${GEN_UI_LIMITS.maxTableRows} rows and ${GEN_UI_LIMITS.maxColumns} columns, a Grid at ${GEN_UI_LIMITS.maxGridColumns}. Split a large request into several cards.`,
  'A button that starts work uses the "prompt" action with the text the user would type; "inject" is only for a turn that is already running.',
  'The spec is a tool argument. Never print it as prose, a code fence, or JSONL patches.',
]

/**
 * The spec the model is shown, kept as data rather than prose so a test can
 * validate it against the catalog and check that every `on` in it sits on a
 * component that fires events. The old example bound `press` on a Card, which
 * is a surface with no event of its own: the model copied a binding that could
 * never fire.
 */
export const HELIX_GEN_UI_EXAMPLE_SPEC = {
  root: 'card',
  elements: {
    card: { type: 'Card', props: { title: 'Test suite' }, children: ['metrics', 'run'] },
    metrics: { type: 'Grid', props: { columns: 2 }, children: ['m1', 'm2'] },
    m1: { type: 'Metric', props: { label: 'Passing', value: '18', tone: 'success' }, children: [] },
    m2: { type: 'Metric', props: { label: 'Failing', value: '3', tone: 'danger' }, children: [] },
    run: {
      type: 'Button',
      props: { label: 'Re-run suite', variant: 'primary' },
      children: [],
      on: { press: { action: 'prompt', params: { text: 'Re-run the full test suite' } } },
    },
  },
}

/** One element per line, the shape the model is expected to write. */
function exampleSpecText(): string {
  const lines = Object.entries(HELIX_GEN_UI_EXAMPLE_SPEC.elements)
    .map(([key, element]) => `    ${JSON.stringify(key)}: ${JSON.stringify(element)}`)
  return [
    '{',
    `  "root": ${JSON.stringify(HELIX_GEN_UI_EXAMPLE_SPEC.root)},`,
    '  "elements": {',
    lines.join(',\n'),
    '  }',
    '}',
  ].join('\n')
}

/**
 * The system-prompt section for `show_ui`.
 *
 * `catalog.prompt()` is written for a model that streams JSONL patches into its
 * answer, which is not the contract here: Helix receives one complete spec as a
 * tool argument. So the section is built from the catalog's own component and
 * action descriptions plus the rules that describe this contract.
 */
export function genUiPromptText(): string {
  const components = helixGenUiCatalog.componentNames.map((name) => {
    const description = (helixGenUiCatalog.data.components as Record<string, { description?: string }>)[name]?.description ?? ''
    const hint = HELIX_GEN_UI_PROP_HINTS[name] ?? ''
    return `- ${name}: ${description}${hint ? ` — props: ${hint}` : ''}`
  })
  const actions = helixGenUiCatalog.actionNames.map((name) => {
    const description = (helixGenUiCatalog.data.actions as Record<string, { description?: string }>)[name]?.description ?? ''
    return `- ${name}: ${description}`
  })
  return [
    `You can put interactive UI in the chat with the \`${GEN_UI_TOOL_NAME}\` tool: a card that shows data, or one the reader acts on. Call it with { title?, spec }, where spec is a json-render spec. The user sees what you render, and a button on it can send a message back to you.`,
    '',
    'AVAILABLE COMPONENTS (anything outside this list is not rendered):',
    ...components,
    '',
    'AVAILABLE ACTIONS (bound through "on"):',
    ...actions,
    '',
    'SPEC SHAPE:',
    ...GEN_UI_SPEC_RULES,
    '',
    'EXAMPLE:',
    exampleSpecText(),
    '',
    'WHEN TO USE IT:',
    ...GEN_UI_USE_FOR,
    '',
    'NOT FOR:',
    ...GEN_UI_NOT_FOR,
    '',
    'TEXT BUDGET:',
    ...GEN_UI_TEXT_BUDGET,
    '',
    'MECHANICS:',
    ...GEN_UI_MECHANICS,
  ].join('\n')
}

export interface GenUiValidation {
  ok: boolean
  message?: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function depthOf(value: unknown, limit: number, depth = 1): number {
  if (depth > limit) return depth
  if (Array.isArray(value)) return value.reduce<number>((max, item: unknown) => Math.max(max, depthOf(item, limit, depth + 1)), depth)
  if (!isPlainRecord(value)) return depth
  return Object.values(value).reduce<number>((max, item: unknown) => Math.max(max, depthOf(item, limit, depth + 1)), depth)
}

function longestText(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce<number>((max, item: unknown) => Math.max(max, longestText(item)), 0)
  if (isPlainRecord(value)) return Object.values(value).reduce<number>((max, item: unknown) => Math.max(max, longestText(item)), 0)
  return 0
}

/**
 * The single gate in front of a spec, used by the DSH-side plugin (so the
 * model gets a repairable tool error) and by the Webview (so a payload that
 * never came from this runtime cannot reach the registry).
 *
 * Caps run first: they are the failures a model hits most, and naming the cap
 * is what makes the next call right. The catalog runs last, and it is checked
 * element by element rather than through `catalog.validate()`: the Svelte
 * schema resolves a component's props from the catalog only for the type field,
 * so props and `on` bindings need their own pass to be guardrails at all.
 */
export function validateGenUiSpec(value: unknown): GenUiValidation {
  if (!isPlainRecord(value)) return { ok: false, message: 'spec must be an object with "root" and "elements".' }
  const serialized = safeStringify(value)
  if (serialized === undefined) return { ok: false, message: 'spec must be JSON-serializable.' }
  if (serialized.length > GEN_UI_LIMITS.maxSpecCharacters) {
    return { ok: false, message: `spec is ${serialized.length} characters; the cap is ${GEN_UI_LIMITS.maxSpecCharacters}. Split it into smaller cards.` }
  }
  if (typeof value.root !== 'string' || !value.root.trim()) return { ok: false, message: 'spec.root must be a non-empty element key.' }
  if (!isPlainRecord(value.elements)) return { ok: false, message: 'spec.elements must be an object of elements keyed by id.' }
  const keys = Object.keys(value.elements)
  if (keys.length === 0) return { ok: false, message: 'spec.elements is empty; a card needs at least one element.' }
  if (keys.length > GEN_UI_LIMITS.maxElements) {
    return { ok: false, message: `spec has ${keys.length} elements; the cap is ${GEN_UI_LIMITS.maxElements}. Split it into smaller cards.` }
  }
  if (depthOf(value, GEN_UI_LIMITS.maxDepth) > GEN_UI_LIMITS.maxDepth + 1) {
    return { ok: false, message: `spec nests deeper than ${GEN_UI_LIMITS.maxDepth} levels.` }
  }
  if (value.state !== undefined) {
    const stateSize = safeStringify(value.state)
    if (stateSize === undefined) return { ok: false, message: 'spec.state must be JSON-serializable.' }
    if (stateSize.length > GEN_UI_LIMITS.maxStateCharacters) {
      return { ok: false, message: `spec.state is ${stateSize.length} characters; the cap is ${GEN_UI_LIMITS.maxStateCharacters}.` }
    }
  }
  if (longestText(value) > GEN_UI_LIMITS.maxPropTextCharacters) {
    return { ok: false, message: `no string in a spec may exceed ${GEN_UI_LIMITS.maxPropTextCharacters} characters.` }
  }

  const structural = validateSpec(value as never)
  if (!structural.valid) {
    const first = structural.issues.find((issue) => issue.severity === 'error')
    return { ok: false, message: first ? `spec is not renderable: ${first.message}${first.elementKey ? ` (element "${first.elementKey}")` : ''}` : 'spec is not renderable.' }
  }
  const issues = catalogIssues(value.elements)
  if (issues.length > 0) return { ok: false, message: `spec does not match the Helix catalog: ${issues.slice(0, 3).join('; ')}${issues.length > 3 ? ` (${issues.length - 3} more)` : ''}` }
  return { ok: true }
}

/** Actions json-render itself answers, beside the ones Helix declares. */
const BUILT_IN_ACTIONS = ['setState', 'pushState', 'removeState', 'validateForm']

function componentDefinitions(): Record<string, { props: unknown }> {
  return helixGenUiCatalog.data.components as Record<string, { props: unknown }>
}

function actionDefinitions(): Record<string, { params: unknown }> {
  return (helixGenUiCatalog.data.actions ?? {}) as Record<string, { params: unknown }>
}

/** One line per element that the catalog would not accept. */
function catalogIssues(elements: Record<string, unknown>): string[] {
  const components = componentDefinitions()
  const actions = actionDefinitions()
  const issues: string[] = []
  for (const key of Object.keys(elements)) {
    const element = elements[key]
    if (!isPlainRecord(element)) {
      issues.push(`${key}: an element must be an object`)
      continue
    }
    const type = typeof element.type === 'string' ? element.type : ''
    const definition = type ? components[type] : undefined
    if (definition === undefined) {
      issues.push(`${key}: "${type || element.type}" is not a Helix component. Use one of ${Object.keys(components).join(', ')}.`)
      continue
    }
    if (element.children !== undefined && (!Array.isArray(element.children) || element.children.some((child) => typeof child !== 'string'))) {
      issues.push(`${key}: "children" must be an array of element keys; leave it out for a leaf`)
    }
    const props = element.props
    if (props !== undefined && !isPlainRecord(props)) {
      issues.push(`${key}: "props" must be an object`)
      continue
    }
    issues.push(...propsIssues(`${key}`, definition.props, isPlainRecord(props) ? props : {}))
    if (type === 'Table') issues.push(...tableIssues(key, isPlainRecord(props) ? props : {}))
    if (type === 'Grid') issues.push(...gridIssues(key, isPlainRecord(props) ? props : {}))
    if (element.on !== undefined) issues.push(...onIssues(`${key}`, element.on, actions))
  }
  return issues
}

/** The caps a table needs, so long data goes to a file the card can open. */
function tableIssues(key: string, props: Record<string, unknown>): string[] {
  const issues: string[] = []
  if (Array.isArray(props.rows) && props.rows.length > GEN_UI_LIMITS.maxTableRows) {
    issues.push(`${key}: a Table is capped at ${GEN_UI_LIMITS.maxTableRows} rows; write longer data to a file and add an openPath action`)
  }
  if (Array.isArray(props.columns) && props.columns.length > GEN_UI_LIMITS.maxColumns) {
    issues.push(`${key}: a Table is capped at ${GEN_UI_LIMITS.maxColumns} columns`)
  }
  if (Array.isArray(props.columns) && Array.isArray(props.rows)) {
    const width = props.columns.length
    const ragged = props.rows.findIndex((row) => Array.isArray(row) && row.length !== width)
    if (ragged >= 0) issues.push(`${key}: row ${ragged} has ${(props.rows[ragged] as unknown[]).length} cells for ${width} columns`)
  }
  return issues
}

/**
 * The Grid cap is a refusal, not a squeeze. Silently widening a three-column
 * layout to four would leave the model looking at a layout it did not ask for,
 * where a tool error tells it to use a Table instead.
 */
function gridIssues(key: string, props: Record<string, unknown>): string[] {
  const columns = props.columns
  if (typeof columns !== 'number' || !Number.isFinite(columns)) return []
  if (columns >= 1 && columns <= GEN_UI_LIMITS.maxGridColumns) return []
  return [`${key}: a Grid fits ${GEN_UI_LIMITS.maxGridColumns} columns in the sidebar; use a Table for more, or Stack for one`]
}

function propsIssues(where: string, schema: unknown, props: Record<string, unknown>): string[] {
  const issues: string[] = []
  const shape = (schema as { shape?: Record<string, unknown> })?.shape
  if (isPlainRecord(shape)) {
    for (const name of Object.keys(props)) {
      if (name in shape) continue
      if (name === 'on' || name === 'action' || name === 'actionParams') {
        issues.push(`${where}: "${name}" is not a prop. An action binding sits on the element as "on": { "press": { "action": …, "params": … } }`)
        continue
      }
      issues.push(`${where}: "${name}" is not a prop of that component. Its props are ${Object.keys(shape).join(', ') || 'none'}.`)
    }
  }
  issues.push(...parseWithSchema(schema, props).messages.map((message) => `${where}.${message}`))
  return issues
}

function onIssues(where: string, on: unknown, actions: Record<string, { params: unknown }>): string[] {
  if (!isPlainRecord(on)) return [`${where}: "on" must be an object of event bindings`]
  const issues: string[] = []
  for (const event of Object.keys(on)) {
    const binding = on[event]
    if (!isPlainRecord(binding)) {
      issues.push(`${where}.on.${event}: a binding must be an object with an "action"`)
      continue
    }
    const name = typeof binding.action === 'string' ? binding.action : ''
    if (!name) {
      issues.push(`${where}.on.${event}: a binding needs an "action" name`)
      continue
    }
    const definition = actions[name]
    if (definition === undefined) {
      if (!BUILT_IN_ACTIONS.includes(name)) {
        issues.push(`${where}.on.${event}: "${name}" is not a Helix action. Use ${Object.keys(actions).join(', ')}${BUILT_IN_ACTIONS.length ? ` or ${BUILT_IN_ACTIONS.join(', ')}` : ''}.`)
      }
      continue
    }
    issues.push(...parseWithSchema(definition.params, isPlainRecord(binding.params) ? binding.params : {})
      .messages.map((message) => `${where}.on.${event} (${name}): ${message}`))
  }
  return issues
}

function parseWithSchema(schema: unknown, value: Record<string, unknown>): { ok: boolean; messages: string[] } {
  const safeParse = (schema as { safeParse?: (value: unknown) => { success: boolean; error?: unknown } } | undefined)?.safeParse
  if (typeof safeParse !== 'function') return { ok: true, messages: [] }
  const result = safeParse.call(schema, value)
  if (result.success) return { ok: true, messages: [] }
  const issues = isPlainRecord(result.error) && Array.isArray(result.error.issues) ? result.error.issues : []
  const messages = issues.slice(0, 2).map((issue) => {
    if (!isPlainRecord(issue)) return 'props are invalid'
    const path = Array.isArray(issue.path) ? issue.path.join('.') : ''
    const message = issueMessage(issue)
    return path ? `${path}: ${message}` : message
  })
  return { ok: false, messages: messages.length > 0 ? messages : ['props are invalid'] }
}

/**
 * Every prop is `literal | expression`, so a bad literal arrives as a union
 * failure whose own message is "Invalid input". The literal branch is the one
 * worth naming: that is the rule the model broke.
 */
function issueMessage(issue: Record<string, unknown>): string {
  if (issue.code === 'invalid_union' && Array.isArray(issue.errors)) {
    for (const group of issue.errors) {
      if (!Array.isArray(group)) continue
      const nested = group.find((entry) => isPlainRecord(entry))
      if (isPlainRecord(nested)) return issueMessage(nested)
    }
  }
  if (issue.code === 'invalid_type' && typeof issue.expected === 'string') {
    return typeof issue.received === 'string' ? `expected ${issue.expected}, received ${issue.received}` : `expected ${issue.expected}`
  }
  return typeof issue.message === 'string' ? issue.message : 'invalid value'
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
