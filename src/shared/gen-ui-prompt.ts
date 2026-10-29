import { helixGenUiCatalog } from './gen-ui-catalog.js'
import { GEN_UI_LIMITS } from './gen-ui-limits.js'

/** The tool name the prompt tells the model to call. Defined here, not in the catalog, so this leaf module never reads a catalog binding at top level. */
export const GEN_UI_TOOL_NAME = 'show_ui'

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
