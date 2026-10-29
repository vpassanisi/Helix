import { validateSpec } from '@json-render/core'
import { helixGenUiCatalog } from './gen-ui-catalog.js'
import { GEN_UI_LIMITS } from './gen-ui-limits.js'

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
