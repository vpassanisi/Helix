import { defineCatalog } from '@json-render/core'
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
      description: 'Open an http(s) link in the user’s browser.',
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

// The prompt section, the size caps and the validation gate moved to their
// own files; this path keeps re-exporting them so existing importers are
// unaffected.
export { GEN_UI_LIMITS } from './gen-ui-limits.js'
export { GEN_UI_TOOL_NAME, HELIX_GEN_UI_EXAMPLE_SPEC, HELIX_GEN_UI_PROP_HINTS, genUiPromptText } from './gen-ui-prompt.js'
export { validateGenUiSpec, type GenUiValidation } from './gen-ui-validation.js'
