import { computeRoot, unpackRefs } from './refs.ts'

/**
 * Normative reconstruction of a ref-encoded model input.
 *
 * This file is the contract a backend implements. A Go port in the collector must produce
 * the same result: the round-trip test in `test/resolve.test.ts` pins the behaviour, and
 * the same rules are documented in README.
 *
 * Rules, in span order per `gen_ai.conversation.id`. The caller supplies the spans of the
 * whole conversation, across traces: an entry publishes once at its birth span, and the
 * trace of that span may be older than the span being resolved.
 *
 * 1. Merge every `dsh.messages` map into one store keyed by ref.
 * 2. On a span with `dsh.resync: true`, adopt its full ordered ref list and drop accumulated state.
 * 3. On a delta span, append its `dsh.message_refs`, and the `dsh.output_refs` of the previous span.
 * 4. Verify the accumulated list against `dsh.context_root`; a mismatch marks the span `partial`.
 * 5. Dereference entries, nested `sections` included, depth-capped, cycles reported as unresolved.
 *
 * A consumer that starts mid-conversation, after the latest checkpoint with birth spans it
 * has not pooled, reports those entries `unresolved` until the pool covers them. That is the
 * honest partial report, not a break; the session-log surface pointers are the repair rung.
 *
 * @module
 */

/** The minimum span shape a resolver reads; any carrier works (SDK span, JSON record, OTLP). */
export type ReadableSpanLike = {
  spanId?: string
  startTime?: number
  attributes: Record<string, unknown>
}

export type ResolvedMessage = {
  role: string
  content: unknown[]
  name?: string
  sections?: Array<{ name: string; resolved: ResolvedMessage | { unresolved: string } }>
  unresolved?: string
}

export interface ResolvedSpan {
  spanId?: string
  refs: string[]
  messages: ResolvedMessage[]
  resync: boolean
  complete: boolean
  partial: boolean
  unresolved: string[]
}

export interface ResolveReport {
  conversationId?: string
  storeSize: number
  spans: ResolvedSpan[]
  partial: boolean
  unresolvedRefs: string[]
}

function refHashLengthOf(algorithm: unknown, fallback = 12): number {
  if (typeof algorithm !== 'string') return fallback
  const match = /^sha256-(\d+)$/.exec(algorithm)
  return match ? Number(match[1]) : fallback
}

function parseEntries(json: unknown, store: Map<string, unknown>): void {
  if (typeof json !== 'string' || json.length === 0) return
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  for (const [ref, entry] of Object.entries(parsed)) store.set(ref, entry)
}

function readRefs(span: ReadableSpanLike, hashLength: number): string[] {
  const packed = span.attributes['dsh.message_refs_packed']
  if (typeof packed === 'string' && packed.length > 0) return unpackRefs(packed, hashLength)
  const refs = span.attributes['dsh.message_refs']
  if (Array.isArray(refs)) return refs.filter((ref): ref is string => typeof ref === 'string')
  return []
}

/** Dereference one entry, recursing through nested section refs. */
function resolveEntry(entry: unknown, store: Map<string, unknown>, depth: number, seen: Set<string>): ResolvedMessage {
  if (entry && typeof entry === 'object' && 'unresolved' in (entry as Record<string, unknown>)) {
    return { role: 'unknown', content: [], unresolved: String((entry as Record<string, unknown>).unresolved) }
  }
  const record = (entry ?? {}) as Record<string, unknown>
  const sections = record.sections
  if (!Array.isArray(sections) || depth <= 0) {
    return {
      role: typeof record.role === 'string' ? record.role : 'unknown',
      content: Array.isArray(record.content) ? record.content : [],
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
    }
  }
  const resolved: NonNullable<ResolvedMessage['sections']> = []
  for (const section of sections) {
    const ref = typeof (section as Record<string, unknown>)?.ref === 'string' ? String((section as Record<string, unknown>).ref) : ''
    if (ref === '' || seen.has(ref)) {
      resolved.push({ name: String((section as Record<string, unknown>)?.name ?? ''), resolved: { role: 'unknown', content: [], unresolved: ref } })
      continue
    }
    seen.add(ref)
    const child = store.get(ref)
    resolved.push({
      name: String((section as Record<string, unknown>)?.name ?? ''),
      resolved: child === undefined ? { role: 'unknown', content: [], unresolved: ref } : resolveEntry(child, store, depth - 1, seen),
    })
  }
  // Nested section entries carry no inline text: the model-facing body is the sections joined
  // by blank lines, which is exactly how DSH renders a prompt and a runtime-context snapshot.
  const joined = resolved
    .map(section => {
      const inner = section.resolved as { content?: Array<{ type?: string; text?: string }> }
      return inner?.content?.map(part => (part?.type === 'text' ? String(part.text ?? '') : '')).filter(part => part.length > 0).join('\n\n') ?? ''
    })
    .filter(part => part.length > 0)
    .join('\n\n')
  const inline = Array.isArray(record.content) ? record.content : []
  return {
    role: typeof record.role === 'string' ? record.role : 'unknown',
    content: inline.length > 0 ? inline : joined.length > 0 ? [{ type: 'text', text: joined }] : [],
    sections: resolved,
  }
}

/**
 * Reconstruct every span's input from refs, in conversation order.
 *
 * Payloads live at their birth spans, so pass the spans of every trace of one conversation.
 * A single trace resolves the content born in its own turn; checkpoint spans anchor the
 * accumulated order, and refs born in older traces resolve from the pooled store.
 */
export function resolveMessages(spans: readonly ReadableSpanLike[]): ResolveReport {
  const ordered = [...spans].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))
  const store = new Map<string, unknown>()
  for (const span of ordered) parseEntries(span.attributes['dsh.messages'], store)

  const hashLength = refHashLengthOf(ordered.find(span => typeof span.attributes['dsh.ref_algorithm'] === 'string')?.attributes['dsh.ref_algorithm'])
  const report: ResolveReport = {
    conversationId: ordered.find(span => typeof span.attributes['gen_ai.conversation.id'] === 'string')?.attributes['gen_ai.conversation.id'] as string | undefined,
    storeSize: store.size,
    spans: [],
    partial: false,
    unresolvedRefs: [],
  }

  let history: string[] = []
  let previousOutputRefs: string[] = []
  for (const span of ordered) {
    if (!('dsh.resync' in span.attributes)) continue
    const refs = readRefs(span, hashLength)
    const resync = span.attributes['dsh.resync'] === true
    const outputRefs = Array.isArray(span.attributes['dsh.output_refs'])
      ? (span.attributes['dsh.output_refs'] as unknown[]).filter((ref): ref is string => typeof ref === 'string')
      : []
    if (resync) {
      history = [...refs]
    } else {
      history = [...history, ...previousOutputRefs.filter(ref => !history.includes(ref)), ...refs.filter(ref => !history.includes(ref))]
    }
    previousOutputRefs = outputRefs

    const unresolved: string[] = []
    const messages = history.map(ref => {
      const entry = store.get(ref)
      if (entry === undefined) {
        unresolved.push(ref)
        return { role: 'unknown', content: [], unresolved: ref }
      }
      return resolveEntry(entry, store, 4, new Set([ref]))
    })

    const root = span.attributes['dsh.context_root']
    const verified = typeof root === 'string' && computeRoot(history, hashLength) === root
    const partial = messages.some(message => message.unresolved !== undefined) || (typeof root === 'string' && !verified)
    report.spans.push({
      spanId: span.spanId,
      refs: [...history],
      messages,
      resync,
      complete: span.attributes['dsh.messages_complete'] === true,
      partial,
      unresolved,
    })
    report.unresolvedRefs.push(...unresolved)
    if (partial) report.partial = true
  }
  return report
}

/** The final reconstructed input of a conversation: the last span's resolved messages. */
export function resolveTranscript(spans: readonly ReadableSpanLike[]): ResolvedMessage[] {
  const report = resolveMessages(spans)
  return report.spans.at(-1)?.messages ?? []
}
