import type { ResolvedConfig } from './config.ts'
import { computeRef, type RefEntry } from './refs.ts'

const secretAssignment = /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|client[_-]?secret)["']?\s*[:=]\s*)(["'][^"']*["']|[^\s,;)}]+)/gi
const authorizationBearer = /(authorization\s*[:=]\s*["']?Bearer\s+)[^\s"',;)}]+/gi
const bearerToken = /\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi
const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const apiKeyLike = /\b(?:sk|rk|pk|ghp|github_pat|AKIA)[-_][A-Za-z0-9_-]{16,}\b/gi
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

export function redactText(value: string): string {
  return value
    .replace(authorizationBearer, '$1[REDACTED]')
    .replace(secretAssignment, '$1"[REDACTED]"')
    .replace(bearerToken, '$1[REDACTED]')
    .replace(jwt, '[REDACTED_TOKEN]')
    .replace(apiKeyLike, '[REDACTED_KEY]')
    .replace(email, '[REDACTED_EMAIL]')
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|client[_-]?secret)$/i.test(key)
        ? '[REDACTED]'
        : redactValue(child),
    ]))
  }
  return value
}

export function serializeCapturedContent(value: unknown, limit: number): string {
  const serialized = JSON.stringify(redactValue(value)) ?? 'null'
  if (serialized.length <= limit) return serialized

  let preview = serialized.slice(0, limit)
  let result = ''
  do {
    result = JSON.stringify({ truncated: true, preview })
    if (result.length > limit) preview = preview.slice(0, Math.max(0, preview.length - (result.length - limit)))
  } while (result.length > limit && preview.length > 0)
  return result.length <= limit ? result : '{"truncated":true}'
}

interface ContentBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  arguments?: string
  toolCallId?: string
  content?: ContentBlock[]
}

interface ConversationMessage {
  id?: string
  role?: string
  content?: any[]
}

function mapBlock(block: ContentBlock, includeToolArguments: boolean): Record<string, unknown> {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return { type: block.type, text: block.text ?? '' }
    case 'image':
      return { type: 'image' }
    case 'file':
      return { type: 'file' }
    case 'tool-call':
      return {
        type: 'tool_call',
        id: block.id,
        name: block.name,
        ...(includeToolArguments ? { arguments: block.arguments } : { arguments: '[REDACTED]' }),
      }
    case 'tool-result':
      return {
        type: 'tool_result',
        id: block.toolCallId,
        content: (block.content ?? []).map(item => mapBlock(item, includeToolArguments)),
      }
    default:
      return { type: block.type ?? 'unknown' }
  }
}

export function capturedMessages(
  messages: readonly ConversationMessage[],
  config: ResolvedConfig,
): string | undefined {
  const mapped = messages.map(message => ({
    role: message.role ?? 'unknown',
    content: (message.content ?? []).map(block => mapBlock(block, config.captureToolArguments)),
  }))
  return serializeCapturedContent(mapped, config.maxContentLength)
}

export function capturedToolArguments(argumentsJson: string, config: ResolvedConfig): string {
  let value: unknown = argumentsJson
  try {
    value = JSON.parse(argumentsJson)
  } catch {
    // Keep malformed model output as a redacted string so it remains inspectable.
  }
  return serializeCapturedContent(value, config.maxContentLength)
}

/** One captured message, ready to publish under its own content ref. */
export interface CapturedMessage {
  /** The derived message object, the watermark key. Identity is stable per content generation. */
  source: object
  /** The published shape: the ref-map value, already redacted and capped. */
  entry: RefEntry
  /** Exact published bytes. The ref is the digest of this string, so a resolved entry equals the ref. */
  payload: string
  /** `true` when a cap shortened this entry's text. */
  entryTruncated: boolean
  /** Section entries this entry names by ref, published alongside it. */
  nested?: CapturedMessage[]
}

function isTextPart(block: any): boolean {
  return block?.type === 'text' || block?.type === 'reasoning'
}

/** Byte cost of an entry when every text part is empty, used to size the text budget. */
function entryOverhead(entry: RefEntry): number {
  const skeleton: RefEntry = {
    ...entry,
    content: (entry.content as any[]).map(block => (isTextPart(block) ? { ...block, text: '' } : block)),
  }
  return JSON.stringify(skeleton).length
}

function textPartLengths(entry: RefEntry): number[] {
  return (entry.content as any[]).filter(isTextPart).map(block => String(block.text ?? '').length)
}

function applyTextBudget(entry: RefEntry, ratio: number): RefEntry {
  const lengths = textPartLengths(entry)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  return {
    ...entry,
    content: (entry.content as any[]).map(block => {
      if (!isTextPart(block)) return block
      const text = String(block.text ?? '')
      const budget = Math.floor(text.length * ratio)
      if (budget >= text.length) return block
      return { ...block, text: text.slice(0, budget), truncated: true }
    }),
    truncated: total > 0,
  }
}

/**
 * Cap one message entry, keeping the message and part shapes intact.
 *
 * The whole-array replacement in {@link serializeCapturedContent} is unusable under
 * refs: a ref must name a payload that is a message, not an array preview. Text parts
 * shrink first and stay marked; whole content collapses only when no text budget fits.
 */
export function capEntry(entry: RefEntry, maxBytes: number): { entry: RefEntry; truncated: boolean } {
  const serialized = JSON.stringify(entry)
  if (serialized.length <= maxBytes) return { entry, truncated: false }

  const overhead = entryOverhead(entry)
  const textBytes = textPartLengths(entry).reduce((sum, length) => sum + length, 0)
  if (textBytes > 0 && overhead < maxBytes) {
    let ratio = (maxBytes - overhead) / textBytes
    for (let attempt = 0; attempt < 12; attempt += 1) {
      ratio = Math.min(1, ratio * 0.98)
      const capped = applyTextBudget(entry, ratio)
      if (JSON.stringify(capped).length <= maxBytes) return { entry: capped, truncated: true }
      if (ratio <= 0) break
    }
  }

  const parts = (entry.content as any[]).length
  for (const content of [
    [{ type: 'text', text: `content omitted: ${parts} parts, ${serialized.length} bytes`, truncated: true }],
    [{ type: 'text', text: 'content omitted', truncated: true }],
    [],
  ]) {
    const collapsed: RefEntry = { ...entry, content, truncated: true }
    if (JSON.stringify(collapsed).length <= maxBytes) return { entry: collapsed, truncated: true }
  }
  return { entry: { role: entry.role, content: [], truncated: true }, truncated: true }
}

/**
 * Map one conversation message to its published entry.
 *
 * Redaction runs here, before any hashing, so a ref digests redacted bytes and a credential
 * can never enter an entry, a ref, or a digest.
 */
export function messageEntry(message: ConversationMessage, config: ResolvedConfig): RefEntry {
  const mapped: RefEntry = {
    role: message.role ?? 'unknown',
    content: (message.content ?? []).map(block => mapBlock(block, config.captureToolArguments)),
  }
  return redactValue(mapped) as RefEntry
}

/**
 * Capture messages as ref-addressable entries.
 *
 * Redaction and the per-entry cap run before hashing, so no credential reaches an entry,
 * a ref, or a digest, and the published bytes are the hashed bytes.
 *
 * `sectionsFor` nests a message's named contributions: the entry carries refs, and the
 * section bytes publish once as `nested` entries. This is what collapses a repeating
 * runtime-context snapshot to its component parts.
 */
export function captureMessageEntries(
  messages: readonly ConversationMessage[],
  config: ResolvedConfig,
  options?: { sectionsFor?: (message: ConversationMessage) => Array<{ name: string; text: string }> | undefined },
): CapturedMessage[] {
  return messages.map(message => {
    const sections = options?.sectionsFor?.(message)
    if (sections && sections.length > 0) {
      const nestedSections = captureSections(sections, config)
      const entry: RefEntry = {
        role: message.role ?? 'unknown',
        content: [],
        sections: nestedSections.map(section => ({ name: section.name, ref: computeRef(section.payload, config.refHashLength) })),
      }
      const payload = JSON.stringify(entry)
      return {
        source: message,
        entry,
        payload,
        entryTruncated: nestedSections.some(section => section.entryTruncated),
        nested: nestedSections.map(section => ({
          source: section,
          entry: section.entry,
          payload: section.payload,
          entryTruncated: section.entryTruncated,
        })),
      }
    }
    const mapped = messageEntry(message, config)
    const { entry, truncated } = capEntry(mapped, config.messageEntryMaxBytes)
    return { source: message, entry, payload: JSON.stringify(entry), entryTruncated: truncated }
  })
}

/** A prompt-section contribution, published under its own content ref. */
export interface CapturedSection {
  name: string
  entry: RefEntry
  payload: string
  entryTruncated: boolean
}

/** Capture rendered prompt sections as system-role entries attributed by section name. */
export function captureSections(
  sections: ReadonlyArray<{ name: string; text: string }>,
  config: ResolvedConfig,
): CapturedSection[] {
  return sections.map(section => {
    const { entry, truncated } = capEntry(
      { name: section.name, role: 'system', content: [{ type: 'text', text: section.text }] },
      config.messageEntryMaxBytes,
    )
    return { name: section.name, entry, payload: JSON.stringify(entry), entryTruncated: truncated }
  })
}

/**
 * Serialize a ref map under a byte limit, keeping the JSON shape valid.
 *
 * An entry that does not fit is dropped and reported in `droppedRefs`, never cut mid-value:
 * a broken map string would corrupt every later reconstruction, which is the failure refs
 * exist to avoid. The caller unmarks a dropped ref so the next resync carries it.
 */
export function serializeEntryMap(
  entries: ReadonlyArray<readonly [string, RefEntry]>,
  limit: number,
): { json: string; dropped: number; droppedRefs: string[]; bytes: number } {
  const kept: string[] = []
  const droppedRefs: string[] = []
  let size = 2
  for (const [ref, entry] of entries) {
    const fragment = `${JSON.stringify(ref)}:${JSON.stringify(entry)}`
    const addition = kept.length === 0 ? fragment.length : fragment.length + 1
    if (size + addition > limit) {
      droppedRefs.push(ref)
      continue
    }
    kept.push(fragment)
    size += addition
  }
  return { json: `{${kept.join(',')}}`, dropped: droppedRefs.length, droppedRefs, bytes: size }
}
