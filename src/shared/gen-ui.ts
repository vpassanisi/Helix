import type { Spec } from '@json-render/core'
import { GEN_UI_LIMITS, validateGenUiSpec } from './gen-ui-catalog.js'
import { isRecord } from './value-utils.js'

export type { Spec as GenUiSpec } from '@json-render/core'
export { GEN_UI_LIMITS, GEN_UI_TOOL_NAME, genUiPromptText, HELIX_GEN_UI_EXAMPLE_SPEC, validateGenUiSpec } from './gen-ui-catalog.js'

/** Where a card stands in the transcript. */
export type GenUiStatus = 'rendered' | 'failed' | 'dismissed'

export interface GenUiView {
  callId: string
  title?: string
  /**
   * The catalog-validated spec. A failed card keeps the raw payload when it
   * parsed as an object, so the transcript can show what arrived.
   */
  spec: Spec
  status: GenUiStatus
  error?: string
}

export const GEN_UI_TITLE_LIMIT = 200
export const GEN_UI_ACTION_TEXT_LIMIT = GEN_UI_LIMITS.maxPropTextCharacters
export const GEN_UI_PATH_LABEL_LIMIT = 300

export type GenUiCall = { ok: true; spec: Spec; title?: string } | { ok: false; message: string }

/**
 * Read a `show_ui` call out of the arguments the runtime recorded.
 *
 * The arguments reach the Webview as part of a `tool/call` session event, and
 * a provider may hand them over as a JSON string, so both forms are accepted.
 * The spec itself is then validated at this boundary too: the Webview never
 * renders a payload the runtime plugin did not sign off on.
 */
export function parseGenUiCall(args: unknown): GenUiCall {
  const payload = typeof args === 'string' ? safeParse(args) : args
  if (!isRecord(payload)) return { ok: false, message: 'show_ui needs a JSON object with a "spec".' }
  const rawSpec = payload.spec
  if (rawSpec === undefined) return { ok: false, message: 'show_ui needs a "spec".' }
  const validated = validateGenUiSpec(rawSpec)
  if (!validated.ok) return { ok: false, message: validated.message ?? 'The spec was rejected.' }
  const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, GEN_UI_TITLE_LIMIT) : undefined
  return { ok: true, spec: rawSpec as Spec, ...(title ? { title } : {}) }
}

/**
 * An action a rendered card asks Helix to take. Every kind is a plain intent
 * with a bounded payload: the card never sends a command, a URI, or a path the
 * Host has not re-checked.
 */
export type GenUiAction =
  | { kind: 'prompt'; text: string }
  | { kind: 'inject'; text: string }
  | { kind: 'openPath'; path: string; label?: string }
  | { kind: 'openLink'; url: string; label?: string }
  | { kind: 'copy'; text: string }
  | { kind: 'dismiss' }

/**
 * Validate an action coming from the Webview, where `workspaceRoots` is the
 * Host's own list of open folders. Throws with a message safe to show.
 */
export function validateGenUiAction(value: unknown, workspaceRoots: readonly string[]): GenUiAction {
  if (!isRecord(value)) throw new Error('UI action is not an object.')
  const kind = value.kind
  if (kind === 'dismiss') return { kind }
  if (kind === 'prompt' || kind === 'inject' || kind === 'copy') {
    const text = boundedText(value.text, GEN_UI_ACTION_TEXT_LIMIT, 'UI action text')
    return { kind, text }
  }
  if (kind === 'openLink') {
    const url = boundedText(value.url, 2_000, 'UI action url')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('UI action url is not a valid URL.')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('UI links may only open http and https addresses.')
    }
    return { kind, url: parsed.toString(), ...(labelOf(value.label) ? { label: labelOf(value.label) } : {}) }
  }
  if (kind === 'openPath') {
    const path = boundedText(value.path, GEN_UI_PATH_LABEL_LIMIT, 'UI action path')
    if (!isAbsolutePath(path)) throw new Error('UI file actions need an absolute path.')
    if (!isInsideWorkspaces(path, workspaceRoots)) {
      throw new Error('UI file actions may only open files inside the open workspace folders.')
    }
    return { kind, path, ...(labelOf(value.label) ? { label: labelOf(value.label) } : {}) }
  }
  throw new Error('Unknown UI action.')
}

function labelOf(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, GEN_UI_TITLE_LIMIT) : ''
}

function boundedText(value: unknown, limit: number, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be text.`)
  const text = value.trim()
  if (!text) throw new Error(`${name} must not be empty.`)
  if (text.length > limit) throw new Error(`${name} is longer than ${limit} characters.`)
  return text
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)
}

/**
 * Pure path containment, with no Node APIs: this rule is enforced in the Host,
 * which owns the workspace roots, and shared by the Webview. Separators and
 * Windows drive letters are normalized, and a match must land on a path
 * boundary, so `/src` never admits `/secret-src`.
 */
export function isInsideWorkspaces(path: string, workspaceRoots: readonly string[]): boolean {
  const target = normalizePath(path)
  return workspaceRoots.some((root) => {
    const base = normalizePath(root)
    if (!base) return false
    if (target === base) return true
    return target.startsWith(base.endsWith('/') ? base : `${base}/`)
  })
}

function normalizePath(value: string): string {
  const separators = value.replace(/\\/g, '/')
  const driveRelative = /^[a-zA-Z]:/.test(separators)
  const leading = separators.startsWith('//') ? '//' : separators.startsWith('/') ? '/' : driveRelative ? '' : '/'
  const segments: string[] = []
  for (const segment of separators.split('/')) {
    if (!segment || segment === '.') continue
    // A `..` that pops past the root leaves the path unmatched by any root,
    // so `/repo/../etc/passwd` cannot claim the workspace it started in.
    if (segment === '..') {
      if (segments.length === 0) return ''
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const drive = driveRelative ? `${separators.slice(0, 2).toLowerCase()}/` : leading === '/' ? '/' : leading
  const resolved = `${drive}${segments.join('/')}`.replace(/\/+$/, '')
  return driveRelative ? resolved.toLowerCase() : resolved
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
