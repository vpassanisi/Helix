import { createHash } from 'node:crypto'

/**
 * Content-addressed refs.
 *
 * A ref identifies the exact bytes this plugin publishes for one message object,
 * after redaction and after shape-preserving truncation, so a resolved entry
 * equals the entry the ref names, byte for byte.
 *
 * @module
 */

/** One published message, the value side of a `dsh.messages` map entry. */
export type RefEntry = {
  role: string
  content: unknown[]
  id?: string
  /** Producer attribution for a prompt-section entry. */
  name?: string
  /** Refs of nested section entries, used by a runtime-context snapshot message. */
  sections?: Array<{ name: string; ref: string }>
  /** `true` when a cap shortened this entry's text. */
  truncated?: boolean
}

/** Self-describing algorithm label emitted as `dsh.ref_algorithm`. */
export function refAlgorithm(hashLength: number): string {
  return `sha256-${hashLength}`
}

/** Truncated SHA-256 hex digest of the exact published payload bytes. */
export function computeRef(payload: string, hashLength: number): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, hashLength)
}

/**
 * Hash of an ordered ref list.
 *
 * `dsh.context_root` values let a consumer verify its accumulated history at every
 * span and name the exact span where a dropped write broke the chain.
 */
export function computeRoot(refs: readonly string[], hashLength = 12): string {
  return computeRef(refs.join(','), hashLength)
}

/** Refs over 6 raw bytes each, base64url packed: 8 chars per ref, not 15 quoted. */
export function packRefs(refs: readonly string[], hashLength: number): string | undefined {
  if (refs.length === 0) return ''
  if (refs.some(ref => ref.length !== hashLength)) return undefined
  return Buffer.from(refs.join(''), 'hex').toString('base64url')
}

/** Inverse of {@link packRefs}. Throws when the packed length is not a whole ref. */
export function unpackRefs(packed: string, hashLength: number): string[] {
  if (packed === '') return []
  const hex = Buffer.from(packed, 'base64url').toString('hex')
  if (hex.length % hashLength !== 0) throw new Error(`packed ref list length ${hex.length / 2} is not a whole ${hashLength / 2}-byte ref`)
  const refs: string[] = []
  for (let offset = 0; offset < hex.length; offset += hashLength) refs.push(hex.slice(offset, offset + hashLength))
  return refs
}

/**
 * Message object to ref cache.
 *
 * Derived messages are shared and deep-frozen per content generation, so a `WeakMap`
 * keyed on the object is an exact watermark that never retains a dead history node.
 * A content-generation rebuild produces new objects, so rewritten messages land here
 * as new refs and republish.
 */
export class RefCache {
  private readonly entries = new WeakMap<object, { ref: string; payload: string }>()
  private collisions = 0
  private readonly hashLength: number

  constructor(hashLength: number) {
    this.hashLength = hashLength
  }

  /** Ref for `message`, hashing `payload` once per object identity. */
  refFor(message: object, payload: string): string {
    const cached = this.entries.get(message)
    if (cached && cached.payload === payload) return cached.ref
    const ref = computeRef(payload, this.hashLength)
    this.entries.set(message, { ref, payload })
    return ref
  }

  /**
   * Widen a ref that collided on a different payload.
   *
   * The suffix-free growth keeps refs hex-representable; a widened ref disables
   * packing for the span that carries it, which the adapter marks explicitly.
   */
  recordCollision(ref: string): number {
    this.collisions += 1
    return Math.min(64, this.hashLength + 8 * this.collisions)
  }

  get collisionCount(): number {
    return this.collisions
  }
}

/**
 * Publication watermark: which refs this plugin has already put on the wire.
 *
 * The watermark spans the whole conversation: an entry publishes once, at its birth
 * span, and refs are answered from that point on. A resync span is a checkpoint of
 * the full context as an ordered ref list; it never restates published payloads.
 *
 * The store is a bounded LRU keyed on recency of naming. Checkpoint spans name every
 * live ref, so current context refreshes and evicted refs are the ones a surface no
 * longer names, compacted away, or the oldest survivors. An evicted ref counts as new
 * at its next namer, so its payload rebirths: that is the recovery path for entries a
 * backend retention window has dropped.
 */
export class PublicationWatermark {
  private readonly published = new Map<string, string>()
  private readonly maxEntries: number

  constructor(maxEntries: number = Number.POSITIVE_INFINITY) {
    this.maxEntries = maxEntries
  }

  /** `true` when the ref is new (or evicted) and is now recorded, `false` when already published. */
  mark(ref: string, payload: string): boolean {
    const existing = this.published.get(ref)
    if (existing === payload) {
      this.published.delete(ref)
      this.published.set(ref, payload)
      return false
    }
    if (this.published.size >= this.maxEntries) {
      const oldest = this.published.keys().next()
      if (!oldest.done && oldest.value !== ref) this.published.delete(oldest.value)
    }
    this.published.delete(ref)
    this.published.set(ref, payload)
    return true
  }

  has(ref: string): boolean {
    return this.published.has(ref)
  }

  /**
   * Forget a ref so its entry republishes.
   *
   * Used when a byte limit dropped the entry from a map, and when an export gap makes
   * recent births suspect: the entry may not be on the wire, so the watermark must not
   * claim it is, and the next span that names it publishes it again.
   */
  unmark(ref: string): void {
    this.published.delete(ref)
  }

  payloadFor(ref: string): string | undefined {
    return this.published.get(ref)
  }

  get size(): number {
    return this.published.size
  }
}
