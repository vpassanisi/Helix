import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context as OtelContext,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api'
import type { ResolvedConfig } from './config.ts'
import {
  capturedMessages,
  capturedToolArguments,
  captureMessageEntries,
  captureSections,
  serializeEntryMap,
  type CapturedMessage,
  type CapturedSection,
} from './privacy.ts'
import {
  PublicationWatermark,
  RefCache,
  computeRef,
  computeRoot,
  packRefs,
  refAlgorithm,
  type RefEntry,
} from './refs.ts'
import {
  INPUT_SHAPING_EVENTS,
  TRIGGER_REASON,
  isKnownEventType,
  isPrefixOf,
  type ResyncReason,
} from './dsh-events.ts'

type SessionId = string
type Session = {
  id: SessionId
  header?: { parentSession?: SessionId; agentPreset?: string }
  requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined
  deriveMessages?: () => Array<DerivedMessage>
  /** Present on DSH builds that expose the surface projection; drives `dsh.surface_*` pointers. */
  surface?: { nodes?: readonly number[]; contentGeneration?: number }
}

type DerivedMessage = {
  id?: string
  role?: string
  content?: unknown[]
  source?: { kind?: string; form?: string; sections?: Array<{ name: string; text: string }> }
}

type DurableEvent = {
  type: string
  time: number
  seq?: number
  data: Record<string, any>
  /** Surface intent of a surface event: `append`, or a `{op:'replace'}` node range. */
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number }
  /** Marks an informational record whose loss cannot change reconstruction. */
  ignorable?: true
}

type AssistantStreamFrame = {
  type: 'start' | 'chunk' | 'end'
  attemptId: string
  turn: number
  step: number
  time?: number
  chunk?: { type?: string; text?: string; argumentsDelta?: string; name?: string }
  outcome?: { kind: 'committed' | 'abandoned'; eventType?: string; seq?: number }
}

type Agent = {
  id?: string
  options?: { provider?: string; model?: string }
  session: Session
}

type ChatSpan = {
  span: Span
  context: SpanContext
  attemptId?: string
  turn: number
  step: number
  startedAt: number
  firstChunkAt?: number
}

type ToolSpan = {
  span: Span
  turn: number
  step: number
}

type SessionState = {
  session: Session
  turn?: number
  step?: number
  root?: Span
  chatByAttempt: Map<string, ChatSpan>
  chatQueueByStep: Map<string, ChatSpan[]>
  lastChatByStep: Map<string, ChatSpan>
  tools: Map<string, ToolSpan>
  provider?: string
  model?: string
  /** Ref identity cache, keyed on the deep-frozen derived message object. */
  refs: RefCache
  /**
   * Refs this plugin has already put on the wire inside the current conversation.
   *
   * The watermark is never reset per trace: an entry publishes once at its birth span,
   * and a resync span checkpoints the full context as refs. The LRU bound evicts the
   * least recently named refs, and an evicted ref rebirths at its next namer.
   */
  watermark: PublicationWatermark
  /** Chat spans settled since the span that published the full ordered list. */
  spansSinceResync: number
  /** Enabled trigger names collected from session events since the last chat span. */
  dirty: Set<ResyncReason>
  /** Entries born since the last checkpoint; an export gap unmarks these for rebirth. */
  refsSinceCheckpoint: string[]
  /** Ordered refs published as the input of the last chat span: the append-only invariant. */
  lastRefs: string[]
  lastContextRoot?: string
  lastSectionRoot?: string
  lastToolRoot?: string
  /** Rendered prompt sections from the last assembly, and the refs they publish under. */
  sections?: Array<{ name: string; text: string }>
  sectionRefs?: string[]
  /** Assembly text the root refs already describe, so a repeat assembly is cheap. */
  sectionSignature?: string
  /** Section entries collected and carried to the next span's `dsh.messages` map. */
  pendingEntries: Array<readonly [string, RefEntry, string]>
  resyncIndex: number
  resynced: boolean
  turnRootPending: boolean
  /** `stateKey` values that already published input, so retries publish once. */
  inputForStep: Set<string>
  lastEventSeq?: number
  inputSeqRange?: { start: number; end: number }
}

function stateKey(session: SessionId, turn: number, step: number): string {
  return `${session}\u0000${turn}\u0000${step}`
}

/**
 * Keep the newest refs that fit a JSON string-array budget.
 *
 * Older content is already published on earlier spans of the conversation, so trimming
 * from the head costs a consumer the least, and `dsh.refs_truncated` says it happened.
 */
function trimRefsTail(refs: readonly string[], limit: number): string[] {
  const quoted = refs.map(ref => JSON.stringify(ref))
  let bytes = 2 + Math.max(0, refs.length - 1) + quoted.reduce((sum, item) => sum + item.length, 0)
  let start = 0
  while (bytes > limit && start < refs.length - 1) {
    bytes -= quoted[start].length + 1
    start += 1
  }
  return refs.slice(start)
}

function time(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

function firstStreamTime(stream: any[] | undefined): number | undefined {
  if (!stream) return undefined
  const times = stream.flatMap(record => {
    if (record?.type === 'chunk' && typeof record.time === 'number') return [record.time]
    if (typeof record?.time0 === 'number') return [record.time0]
    return []
  })
  return times.length ? Math.min(...times) : undefined
}

function finishReason(stream: any[] | undefined, interrupted?: boolean): string | undefined {
  if (interrupted) return 'cancelled'
  for (let i = (stream?.length ?? 0) - 1; i >= 0; i -= 1) {
    const record = stream![i]
    const chunk = record?.type === 'chunk' ? record.chunk : undefined
    if (chunk?.type === 'finish' && chunk.reason?.kind) {
      switch (chunk.reason.kind) {
        case 'tool-calls': return 'tool_calls'
        case 'max-tokens': return 'max_tokens'
        case 'aborted': return 'cancelled'
        default: return String(chunk.reason.kind)
      }
    }
  }
  return undefined
}

function finishErrorType(stream: any[] | undefined): string | undefined {
  for (let i = (stream?.length ?? 0) - 1; i >= 0; i -= 1) {
    const record = stream![i]
    const failure = record?.type === 'chunk' && record.chunk?.type === 'finish'
      ? record.chunk.reason?.failure
      : undefined
    if (failure) return String(failure.code ?? failure.name ?? 'model_error')
  }
  return undefined
}

function hasFirstToken(chunk: AssistantStreamFrame['chunk']): boolean {
  if (!chunk) return false
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return Boolean(chunk.text?.trim())
  if (chunk.type === 'tool-call-delta') return Boolean(chunk.name || chunk.argumentsDelta)
  return false
}

function currentPromptMessages(session: Session, settledMessageId?: string): DerivedMessage[] {
  return (session.deriveMessages?.() ?? []).filter(message => message.id !== settledMessageId)
}

/** The plugin counts delivered spans per destination so an invisible queue drop surfaces as a resync. */
export type DeliveryCounter = { exported: number }

export class TraceAdapter {
  private readonly sessions = new Map<SessionId, SessionState>()
  private readonly latestRootBySession = new Map<SessionId, SpanContext>()
  private closed = false
  private readonly tracer: Tracer
  private readonly config: ResolvedConfig
  private readonly triggerReasons: Set<ResyncReason>
  private warnedUnknownEvents = false
  private deliveryCounter?: DeliveryCounter
  private createdChatSpans = 0

  constructor(tracer: Tracer, config: ResolvedConfig) {
    this.tracer = tracer
    this.config = config
    this.triggerReasons = new Set(
      config.resyncOn.map(name => TRIGGER_REASON[name]).filter((reason): reason is ResyncReason => reason !== undefined),
    )
  }

  /** Delivery accounting supplied by the exporter wrapper. */
  setDeliveryCounter(counter: DeliveryCounter): void {
    this.deliveryCounter = counter
  }

  /**
   * A destination reported an export failure: the next span of every session checkpoints,
   * and entries born since the last checkpoint unmark and republish on it.
   */
  markExportGap(): void {
    if (!this.config.exportGapResyncs) return
    for (const state of this.sessions.values()) {
      if (this.triggerReasons.has('export_gap')) state.dirty.add('export_gap')
    }
  }

  /** `system-prompt/change`: a registry change can alter assembled sections at the next assembly. */
  notePromptRegistryChange(): void {
    for (const state of this.sessions.values()) {
      if (this.triggerReasons.has('prompt_sections')) state.dirty.add('prompt_sections')
    }
  }

  /**
   * Record the authoritative sections of one assembly for its session.
   *
   * `name` and rendered `text` come from the `system-prompt/assemble` waterfall result, and
   * `toolNames` from the same assembly's visible tools.
   */
  noteAssembly(
    sessionId: SessionId,
    sections: Array<{ name: string; text: string }>,
    toolNames?: readonly string[],
  ): void {
    if (this.closed) return
    const state = this.getState({ id: sessionId } as Session)
    state.sections = sections
    const sectionRoot = computeRoot(sections.map(section => computeRef(section.text, this.config.refHashLength)), this.config.refHashLength)
    if (state.lastSectionRoot !== undefined && state.lastSectionRoot !== sectionRoot && this.triggerReasons.has('prompt_sections')) {
      state.dirty.add('prompt_sections')
    }
    state.lastSectionRoot = sectionRoot
    if (toolNames) {
      const toolRoot = computeRoot([...toolNames].sort(), this.config.refHashLength)
      if (state.lastToolRoot !== undefined && state.lastToolRoot !== toolRoot && this.triggerReasons.has('tool_set')) {
        state.dirty.add('tool_set')
      }
      state.lastToolRoot = toolRoot
    }
    // DSH assembles the prompt after the turn opens, so the root span is open but has no
    // section refs yet. Publish here too; the signature guard keeps repeats cheap.
    if (state.root) this.publishSectionRefs(state, state.root)
  }

  onSessionEvent(session: Session, event: DurableEvent): void {
    if (this.closed) return
    const state = this.getState(session)
    this.noteEvent(state, event)
    switch (event.type) {
      case 'turn/start':
        this.startTurn(state, event)
        break
      case 'turn/end':
        this.endTurn(state, event)
        break
      case 'step/start':
        state.turn = event.data.turn
        state.step = event.data.step
        if (!state.root) this.startTurn(state, { ...event, type: 'turn/start', data: { turn: event.data.turn } })
        break
      case 'step/end':
        this.endStep(state, event)
        break
      case 'request/header':
        state.provider = event.data.header?.config?.provider ?? state.provider
        state.model = event.data.header?.config?.model ?? state.model
        break
      case 'request/context':
        state.provider = event.data.provider ?? state.provider
        state.model = event.data.model ?? state.model
        break
      case 'assistant/message':
        this.endChatFromEvent(state, event, false)
        break
      case 'assistant/attempt':
        this.endChatFromEvent(state, event, true)
        break
      case 'tool/call':
        this.startTool(state, event)
        break
      case 'tool/result':
        this.endTool(state, event)
        break
      default:
        break
    }
  }

  onAssistantStream(payload: { agent: Agent; frame: AssistantStreamFrame }): void {
    if (this.closed) return
    const { agent, frame } = payload
    const state = this.getState(agent.session)
    state.provider = agent.options?.provider ?? state.provider
    state.model = agent.options?.model ?? state.model
    if (frame.type === 'start') {
      if (!state.root) this.startTurn(state, { type: 'turn/start', time: Date.now(), data: { turn: frame.turn } })
      const key = stateKey(agent.session.id, frame.turn, frame.step)
      const span = this.tracer.startSpan(
        state.model ? `chat ${state.model}` : 'chat',
        {
          startTime: Date.now(),
          attributes: this.chatAttributes(state, frame.turn, frame.step),
        },
        this.parentContext(state),
      )
      const chat: ChatSpan = {
        span,
        context: span.spanContext(),
        attemptId: frame.attemptId,
        turn: frame.turn,
        step: frame.step,
        startedAt: Date.now(),
      }
      state.chatByAttempt.set(frame.attemptId, chat)
      state.lastChatByStep.set(key, chat)
      const queue = state.chatQueueByStep.get(key) ?? []
      queue.push(chat)
      state.chatQueueByStep.set(key, queue)
    } else if (frame.type === 'chunk') {
      const chat = state.chatByAttempt.get(frame.attemptId)
      if (chat && !chat.firstChunkAt && hasFirstToken(frame.chunk)) {
        chat.firstChunkAt = time(frame.time)
        chat.span.addEvent('gen_ai.stream.first_chunk', {
          'dsh.stream.first_chunk_ms': Math.max(0, chat.firstChunkAt - chat.startedAt),
        }, chat.firstChunkAt)
      }
    } else if (frame.type === 'end' && frame.outcome?.kind === 'abandoned') {
      const chat = state.chatByAttempt.get(frame.attemptId)
      if (chat) {
        chat.span.setAttribute('gen_ai.response.finish_reasons', ['cancelled'])
        chat.span.setAttribute('error.type', 'cancelled')
        this.finishChat(state, chat, Date.now())
      }
    }
  }

  onSessionDisposed(session: Session): void {
    const state = this.sessions.get(session.id)
    if (!state) return
    const now = Date.now()
    for (const chat of state.chatByAttempt.values()) this.finishChat(state, chat, now)
    for (const chat of state.chatQueueByStep.values()) {
      for (const item of chat) this.finishChat(state, item, now)
    }
    for (const tool of state.tools.values()) this.finishTool(state, tool, now, 'cancelled')
    state.root?.end(now)
    this.sessions.delete(session.id)
    this.latestRootBySession.delete(session.id)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const state of this.sessions.values()) this.onSessionDisposed(state.session)
    this.sessions.clear()
  }

  private getState(session: Session): SessionState {
    let state = this.sessions.get(session.id)
    if (!state) {
      state = {
        session,
        chatByAttempt: new Map(),
        chatQueueByStep: new Map(),
        lastChatByStep: new Map(),
        tools: new Map(),
        provider: session.requestHeader?.()?.config?.provider,
        model: session.requestHeader?.()?.config?.model,
        refs: new RefCache(this.config.refHashLength),
        watermark: new PublicationWatermark(this.config.watermarkMaxEntries),
        spansSinceResync: 0,
        dirty: new Set(),
        refsSinceCheckpoint: [],
        lastRefs: [],
        pendingEntries: [],
        resyncIndex: 0,
        resynced: false,
        turnRootPending: false,
        inputForStep: new Set(),
      }
      this.sessions.set(session.id, state)
    } else {
      state.session = session
    }
    return state
  }

  /** Layer-2 trigger collection: mark the causes an enabled policy asked to see. */
  private noteEvent(state: SessionState, event: DurableEvent): void {
    if (typeof event.seq === 'number') state.lastEventSeq = event.seq
    const reason = this.triggerFor(event)
    if (reason) state.dirty.add(reason)
  }

  private triggerFor(event: DurableEvent): ResyncReason | undefined {
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.kind === 'runtime-context') {
        return this.triggerReasons.has('runtime_context') ? 'runtime_context' : undefined
      }
      return this.triggerReasons.has('user_message') ? 'user_message' : undefined
    }
    const shaped = INPUT_SHAPING_EVENTS[event.type]
    if (shaped) return this.triggerReasons.has(shaped) ? shaped : undefined
    if (event.surfaceOp && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      return this.triggerReasons.has('surface_replace') ? 'surface_replace' : undefined
    }
    if (!isKnownEventType(event.type) && !event.ignorable) {
      this.warnUnknownEvent(event.type)
      return this.triggerReasons.has('unknown_event') ? 'unknown_event' : undefined
    }
    return undefined
  }

  private warnUnknownEvent(type: string): void {
    if (this.warnedUnknownEvents) return
    this.warnedUnknownEvents = true
    try {
      this.onWarn?.(`[dsh-otel-plugin] unrecognized session event "${type}": the full ref list is checkpointed on every resync until the catalog is updated`)
    } catch {
      // Diagnostics are best effort.
    }
  }

  /** Diagnostic sink wired by the plugin entry point. */
  onWarn?: (message: string) => void

  private parentContext(state: SessionState): OtelContext {
    return state.root ? trace.setSpanContext(ROOT_CONTEXT, state.root.spanContext()) : ROOT_CONTEXT
  }

  /**
   * Open a trace, which covers one turn.
   *
   * A trace starts when the user sends a message, opens the turn, and ends when the agent
   * gives the final response at `turn/end`. Content deduplication spans the conversation:
   * an entry publishes once at its birth span, and the trace's first span is a delta, not
   * an automatic checkpoint. Per-trace resets cover only the state that repeats per root:
   * the section list the root must name, and the retry dedupe set.
   */
  private startTrace(state: SessionState): void {
    state.sectionRefs = undefined
    state.sectionSignature = undefined
    state.pendingEntries = []
    state.inputForStep = new Set()
  }

  private startTurn(state: SessionState, event: DurableEvent): void {
    if (state.root) {
      this.closeTurnChildren(state, state.turn ?? 0, event.time)
      state.root.end(time(event.time))
    }
    const turn = event.data.turn ?? 0
    state.turn = turn
    this.startTrace(state)
    const parentId = state.session.header?.parentSession
    const parent = parentId ? this.latestRootBySession.get(parentId) : undefined
    const agentName = state.session.header?.agentPreset
    const span = this.tracer.startSpan(
      agentName ? `invoke_agent ${agentName}` : 'invoke_agent',
      {
        startTime: time(event.time),
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.conversation.id': state.session.id,
          'gen_ai.agent.id': state.session.id,
          'dsh.turn': turn,
          ...(agentName ? { 'gen_ai.agent.name': agentName } : {}),
        },
        ...(parent ? { links: [{ context: parent }] } : {}),
      },
      ROOT_CONTEXT,
    )
    state.root = span
    this.latestRootBySession.set(state.session.id, span.spanContext())
    state.turnRootPending = true
    this.publishSectionRefs(state, span)
  }

  /**
   * Publish the ordered prompt-section refs of this agent's assembly on the turn root.
   *
   * The root also carries the bytes of sections the conversation has not published yet, so
   * each section entry travels in the trace of its birth. Entries the byte cap drops stay
   * unmarked, and the next span that names them publishes them.
   */
  private publishSectionRefs(state: SessionState, root: Span): void {
    if (!this.config.captureSystemPromptSections || !this.config.capturePrompts) return
    if (!state.sections) return
    const signature = state.sections.map(section => `${section.name}\u0000${section.text}`).join('\u0001')
    if (state.sectionSignature === signature && state.sectionRefs) return
    state.sectionSignature = signature
    const entries = captureSections(state.sections, this.config)
    const refs: string[] = []
    const published: Array<readonly [string, RefEntry]> = []
    for (const entry of entries) {
      const ref = computeRef(entry.payload, this.config.refHashLength)
      refs.push(ref)
      state.pendingEntries.push([ref, entry.entry, entry.payload])
      if (state.watermark.mark(ref, entry.payload)) {
        published.push([ref, entry.entry])
        state.refsSinceCheckpoint.push(ref)
      }
    }
    root.setAttribute('dsh.system_prompt_refs', refs)
    root.setAttribute('dsh.system_prompt_root', computeRoot(refs, this.config.refHashLength))
    root.setAttribute('dsh.ref_algorithm', refAlgorithm(this.config.refHashLength))
    root.setAttribute('dsh.system_prompt_decomposed', this.verifyDecomposition(state, entries) ? true : false)
    state.sectionRefs = refs

    if (published.length === 0) return
    const map = serializeEntryMap(published, this.config.maxContentLength)
    if (map.json === '{}') return
    root.setAttribute('dsh.messages', map.json)
    if (map.dropped > 0) {
      root.setAttribute('dsh.entries_truncated', true)
      for (const ref of map.droppedRefs) state.watermark.unmark(ref)
    }
    root.setAttribute('dsh.messages_complete', map.dropped === 0)
  }

  /**
   * Confirm the section decomposition is authoritative.
   *
   * DSH renders sections by dropping empty ones and joining with blank lines, and a
   * `complete: true` section is restored after the assembly waterfall, so a listener can
   * see a list that is not what the model received. Equality against the system message
   * in history is the check; inequality means publish one ref for the whole prompt.
   */
  private verifyDecomposition(state: SessionState, entries: CapturedSection[]): boolean {
    const systemMessage = currentPromptMessages(state.session).find(message => message.role === 'system')
    if (!systemMessage) return entries.length > 0
    this.stateOfMessage.set(systemMessage, state)
    const text = (systemMessage.content as any[] | undefined)
      ?.map(block => (block?.type === 'text' ? String(block.text ?? '') : ''))
      .filter(part => part.length > 0)
      .join('\n\n')
    if (text === undefined) return false
    const joined = entries
      .map(entry => String((entry.entry.content as any[])?.[0]?.text ?? ''))
      .filter(part => part.length > 0)
      .join('\n\n')
    const verified = joined === text
    if (verified) this.verifiedSystemTexts.add(systemMessage)
    else this.verifiedSystemTexts.delete(systemMessage)
    return verified
  }

  private endTurn(state: SessionState, event: DurableEvent): void {
    const turn = event.data.turn
    this.closeTurnChildren(state, turn, event.time)
    if (state.root && state.turn === turn) {
      const reason = event.data.reason
      if (reason?.kind === 'error') {
        state.root.setAttribute('error.type', reason.error?.code ?? reason.error?.name ?? 'turn_error')
        state.root.setStatus({ code: SpanStatusCode.ERROR })
      } else if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') {
        state.root.setAttribute('gen_ai.response.finish_reasons', [reason.kind === 'aborted' ? 'cancelled' : 'interrupted'])
      } else if (reason?.kind === 'max-tokens') {
        state.root.setAttribute('gen_ai.response.finish_reasons', ['max_tokens'])
      }
      state.root.end(time(event.time))
      state.root = undefined
    }
  }

  private endStep(state: SessionState, event: DurableEvent): void {
    const turn = event.data.turn
    const step = event.data.step
    const key = stateKey(state.session.id, turn, step)
    const queue = state.chatQueueByStep.get(key) ?? []
    for (const chat of [...queue]) this.finishChat(state, chat, event.time)
    for (const tool of [...state.tools.values()]) {
      if (tool.turn === turn && tool.step === step) this.finishTool(state, tool, event.time, 'cancelled')
    }
    state.lastChatByStep.delete(key)
    state.step = undefined
  }

  private closeTurnChildren(state: SessionState, turn: number, at: number): void {
    for (const [key, chats] of state.chatQueueByStep) {
      for (const chat of [...chats]) if (chat.turn === turn) this.finishChat(state, chat, at)
      if (key.startsWith(`${state.session.id}\u0000${turn}\u0000`)) state.lastChatByStep.delete(key)
    }
    for (const tool of [...state.tools.values()]) {
      if (tool.turn === turn) this.finishTool(state, tool, at, 'cancelled')
    }
  }

  private chatAttributes(state: SessionState, turn = state.turn, step = state.step): Record<string, string | number> {
    return {
      'gen_ai.operation.name': 'chat',
      ...(state.provider ? { 'gen_ai.provider.name': state.provider } : {}),
      ...(state.model ? { 'gen_ai.request.model': state.model } : {}),
      'gen_ai.conversation.id': state.session.id,
      ...(turn !== undefined ? { 'dsh.turn': turn } : {}),
      ...(step !== undefined ? { 'dsh.step': step } : {}),
    }
  }

  private endChatFromEvent(state: SessionState, event: DurableEvent, failedAttempt: boolean): void {
    const data = event.data
    const key = stateKey(state.session.id, data.turn, data.step)
    const queue = state.chatQueueByStep.get(key) ?? []
    const chat = queue[0] ?? this.createSettledChat(state, event)
    const reason = finishReason(data.stream, data.interrupted)
    if (reason) chat.span.setAttribute('gen_ai.response.finish_reasons', [reason])
    const responseModel = data.message?.source?.model
    if (responseModel) chat.span.setAttribute('gen_ai.response.model', responseModel)
    if (data.usage) {
      // DSH token counts are DISJOINT: inputTokens is uncached input only, and the
      // cache buckets sit beside it (see TokenUsage in @deepseek-ai/dsh-llm). OTel
      // GenAI defines gen_ai.usage.input_tokens as the whole prompt, with
      // cache_read.input_tokens and cache_creation.input_tokens as subsets of it, and
      // OpenInference asks for the same shape in llm.token_count.prompt. Fold the
      // buckets in, so a consumer that reads the total does not have to repair it.
      const cacheRead = data.usage.cacheReadTokens
      const cacheWrite = data.usage.cacheWriteTokens
      const inputTokens = data.usage.inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0)
      chat.span.setAttribute('gen_ai.usage.input_tokens', inputTokens)
      chat.span.setAttribute('gen_ai.usage.output_tokens', data.usage.outputTokens)
      // A provider total excludes the cache buckets DSH reports beside inputTokens,
      // so it is only authoritative while no cache bucket is present.
      const totalTokens = cacheRead !== undefined || cacheWrite !== undefined
        ? inputTokens + data.usage.outputTokens
        : data.usage.totalTokens
      if (totalTokens !== undefined) chat.span.setAttribute('gen_ai.usage.total_tokens', totalTokens)
      if (cacheRead !== undefined) chat.span.setAttribute('gen_ai.usage.cache_read.input_tokens', cacheRead)
      // The registry name for written cache input is cache_creation.input_tokens. The
      // OpenInference spelling cache_write is a different name, and Phoenix's converter
      // drops it, so cache-write tokens never reach llm.token_count.prompt_details.
      if (cacheWrite !== undefined) chat.span.setAttribute('gen_ai.usage.cache_creation.input_tokens', cacheWrite)
      // reasoningTokens is a subset of outputTokens, which is exactly what
      // gen_ai.usage.reasoning.output_tokens means, so it is emitted as-is.
      if (data.usage.reasoningTokens !== undefined) chat.span.setAttribute('gen_ai.usage.reasoning.output_tokens', data.usage.reasoningTokens)
    }

    if (this.config.capturePrompts) {
      if (this.config.inputMessagesMode === 'full') {
        const prompt = capturedMessages(currentPromptMessages(state.session, data.message?.id), this.config)
        if (prompt) chat.span.setAttribute('gen_ai.input.messages', prompt)
      } else {
        this.publishInputRefs(state, chat, data)
      }
    }
    if (!failedAttempt && this.config.captureResponses && data.message?.content) {
      const response = capturedMessages([data.message], this.config)
      if (response) chat.span.setAttribute('gen_ai.output.messages', response)
    }

    if (failedAttempt) {
      if (reason === 'cancelled') {
        chat.span.setAttribute('error.type', 'cancelled')
      } else {
        chat.span.setAttribute('error.type', finishErrorType(data.stream) ?? 'model_attempt_failed')
        chat.span.setStatus({ code: SpanStatusCode.ERROR })
      }
    } else if (data.interrupted) {
      chat.span.setAttribute('error.type', 'cancelled')
    }
    this.finishChat(state, chat, event.time)
  }

  /**
   * Named contributions of a runtime-context snapshot message, when it carries them.
   *
   * DSH publishes the snapshot with its sections, so the repeating part of a snapshot
   * becomes refs to the named contributions and each contribution dedupes on its own.
   */
  private snapshotSections(message: DerivedMessage): Array<{ name: string; text: string }> | undefined {
    if (!this.config.captureSystemPromptSections) return undefined
    if (message.role === 'system') {
      // A verified decomposition turns the largest single entry in every context — the whole
      // rendered prompt — into refs to its sections, published once per scope. The resolver
      // rejoins them exactly as DSH renders them.
      if (!this.verifiedSystemTexts.has(message)) return undefined
      return this.stateOf(message)?.sections
    }
    const source = message.source
    if (source?.kind !== 'runtime-context' || source.form !== 'snapshot') return undefined
    const sections = source.sections
    if (!Array.isArray(sections) || sections.length === 0) return undefined
    return sections.filter(section => typeof section?.name === 'string' && typeof section?.text === 'string')
  }

  private readonly stateOfMessage = new WeakMap<object, SessionState>()
  private readonly verifiedSystemTexts = new WeakSet<object>()

  private stateOf(message: object): SessionState | undefined {
    return this.stateOfMessage.get(message)
  }

  /**
   * Publish refs, entries, and roots for one chat span.
   *
   * A resync span carries the full ordered ref list; a delta span carries only refs and
   * entries the conversation watermark has not published; the span's own output rides the
   * same map. `dsh.context_root` and `dsh.prev_context_root` let a consumer verify its
   * accumulation at every span and name the exact span where a dropped write broke the chain.
   */
  private publishInputRefs(state: SessionState, chat: ChatSpan, data: Record<string, any>): void {
    const config = this.config
    const stepKey = stateKey(state.session.id, data.turn, data.step)
    const alreadyPublished = state.inputForStep.has(stepKey)
    const list = currentPromptMessages(state.session, data.message?.id)
    const captured = captureMessageEntries(list, config, {
      sectionsFor: message => this.snapshotSections(message),
    })
    const refs: string[] = []
    const entries: Array<readonly [string, RefEntry]> = []
    const newRefs: string[] = []
    const bornHere: string[] = []
    const onSpan = new Set<string>()
    const exportGap = state.dirty.has('export_gap')
    if (exportGap) {
      // A span lost to an export gap may have carried these births on its map: the watermark
      // must stop claiming them, and this span republishes them as its own entries.
      for (const ref of state.refsSinceCheckpoint) state.watermark.unmark(ref)
      state.refsSinceCheckpoint = []
    }
    /**
     * Publish one entry.
     *
     * `kind` decides whether the ref joins the delta list. `dsh.message_refs` is what a
     * consumer appends to its history, so it carries input refs only: the span's own
     * output travels in `dsh.output_refs`, and prompt-section bytes answer refs the
     * turn root already carries.
     *
     * The watermark spans the conversation, so an entry publishes at its birth span and
     * a ref published in an older trace is answered from there, never repeated here.
     */
    const publish = (ref: string, entry: RefEntry, payload: string, kind: 'input' | 'output' | 'section'): void => {
      const isNew = state.watermark.mark(ref, payload)
      if (isNew) bornHere.push(ref)
      if (isNew && kind === 'input') newRefs.push(ref)
      if (!isNew) return
      onSpan.add(ref)
      entries.push([ref, entry])
    }

    for (const message of captured) {
      const ref = state.refs.refFor(message.source, message.payload)
      refs.push(ref)
      for (const nested of message.nested ?? []) {
        publish(computeRef(nested.payload, config.refHashLength), nested.entry, nested.payload, 'section')
      }
      publish(ref, message.entry, message.payload, 'input')
    }
    for (const [ref, entry, payload] of state.pendingEntries) {
      publish(ref, entry, payload, 'section')
    }
    state.pendingEntries = []

    const outputRefs: string[] = []
    if (data.message) {
      const [output] = captureMessageEntries([data.message], config)
      const ref = state.refs.refFor(output.source, output.payload)
      outputRefs.push(ref)
      publish(ref, output.entry, output.payload, 'output')
    }

    const root = computeRoot(refs, config.refHashLength)
    chat.span.setAttribute('dsh.ref_algorithm', refAlgorithm(config.refHashLength))
    chat.span.setAttribute('dsh.ref_encoding', config.refEncoding)
    chat.span.setAttribute('dsh.context_root', root)
    if (state.lastContextRoot !== undefined) chat.span.setAttribute('dsh.prev_context_root', state.lastContextRoot)
    if (outputRefs.length > 0) chat.span.setAttribute('dsh.output_refs', outputRefs)
    if (state.lastToolRoot !== undefined) chat.span.setAttribute('dsh.tool_root', state.lastToolRoot)
    this.noteSurfacePointers(state, chat.span)

    if (alreadyPublished) {
      // A retry at a settled step shares its input: the first span published refs and entries.
      chat.span.setAttribute('dsh.resync', false)
      state.inputForStep.add(stepKey)
      state.lastRefs = refs
      state.lastContextRoot = root
      return
    }
    state.inputForStep.add(stepKey)

    const reasons = new Set<ResyncReason>()
    // A session opens with a checkpoint, so its first chat span carries the full list.
    // Later checkpoints follow the cadence and Layer-1 breaks; turns in between are deltas.
    if (!state.resynced) reasons.add('session_start')
    // The counter counts spans without a checkpoint including this one, so a limit of 16 means
    // fifteen spans may pass delta-only and the sixteenth checkpoints: 0, 16, 32, 48.
    if (config.maxSpansBetweenResyncs > 0 && state.spansSinceResync + 1 >= config.maxSpansBetweenResyncs) reasons.add('watchdog')
    if (state.lastRefs.length > 0 && !isPrefixOf(state.lastRefs, refs)) reasons.add('prefix_broken')
    if (state.turnRootPending) {
      if (this.triggerReasons.has('turn_root')) reasons.add('turn_root')
      state.turnRootPending = false
    }
    for (const reason of state.dirty) reasons.add(reason)
    state.dirty.clear()
    const resync = reasons.size > 0
    let dropped = 0

    if (resync) {
      state.resynced = true
      state.resyncIndex += 1
      state.spansSinceResync = 0
      // This span's births are the next window an export gap can unmark.
      state.refsSinceCheckpoint = bornHere
      chat.span.setAttribute('dsh.resync', true)
      chat.span.setAttribute('dsh.resync_reason', [...reasons].join(','))
      chat.span.setAttribute('dsh.resync_index', state.resyncIndex)
      if (exportGap) chat.span.setAttribute('dsh.export_gap', true)
      const packed = config.refEncoding === 'base64url' ? packRefs(refs, config.refHashLength) : undefined
      if (packed !== undefined && packed.length <= config.maxContentLength) {
        chat.span.setAttribute('dsh.message_refs_packed', packed)
      } else {
        if (packed === undefined) chat.span.setAttribute('dsh.ref_collision', state.refs.collisionCount > 0)
        const trimmed = trimRefsTail(refs, config.maxContentLength)
        chat.span.setAttribute('dsh.message_refs', trimmed)
        if (trimmed.length < refs.length) chat.span.setAttribute('dsh.refs_truncated', true)
      }
    } else {
      state.spansSinceResync += 1
      for (const ref of bornHere) state.refsSinceCheckpoint.push(ref)
      chat.span.setAttribute('dsh.resync', false)
      if (newRefs.length > 0) chat.span.setAttribute('dsh.message_refs', newRefs)
    }

    if (entries.length > 0) {
      const map = serializeEntryMap(entries, config.maxContentLength)
      if (map.json !== '{}') chat.span.setAttribute('dsh.messages', map.json)
      if (map.dropped > 0) {
        dropped = map.dropped
        chat.span.setAttribute('dsh.entries_truncated', true)
        for (const ref of map.droppedRefs) state.watermark.unmark(ref)
      }
    }

    // The flag speaks about one span: the span's map carries every entry the span published.
    // Refs naming older content resolve from the conversation pool, and the span claims no
    // more than it delivers.
    chat.span.setAttribute(
      'dsh.messages_complete',
      dropped === 0 && entries.length === onSpan.size,
    )
    if (state.sectionRefs) chat.span.setAttribute('dsh.system_prompt_refs', state.sectionRefs)
    this.applyGenAiInputMode(state, chat.span, config, captured, refs, resync, list)

    state.lastRefs = refs
    state.lastContextRoot = root
    this.createdChatSpans += 1
    if (this.deliveryCounter && this.deliveryCounter.exported < this.createdChatSpans) this.markExportGap()
  }

  /** Shape `gen_ai.input.messages` for the configured mode. */
  private applyGenAiInputMode(
    state: SessionState,
    span: Span,
    config: ResolvedConfig,
    captured: CapturedMessage[],
    refs: string[],
    resync: boolean,
    list: DerivedMessage[],
  ): void {
    switch (config.inputMessagesMode) {
      case 'refs': {
        // The trial shape: an ordered list of content refs. Not semconv-conformant by design.
        span.setAttribute('gen_ai.input.messages', JSON.stringify(refs))
        return
      }
      case 'objects': {
        const objects = captured.map((message, index) => ({ role: message.entry.role, parts: [], ref: refs[index] }))
        span.setAttribute('gen_ai.input.messages', JSON.stringify(objects))
        return
      }
      case 'checkpoint': {
        if (!resync) return
        const full = capturedMessages(list, config)
        if (full) span.setAttribute('gen_ai.input.messages', full)
        return
      }
      case 'omit':
        return
      default:
        return
    }
  }

  /** Surface pointers: a log-connected resolver can rebuild and verify without any ref list. */
  private noteSurfacePointers(state: SessionState, span: Span): void {
    if (!this.config.contextPointers) return
    const nodes = state.session.surface?.nodes
    if (Array.isArray(nodes) && nodes.length > 0) {
      span.setAttribute('dsh.surface_seq_start', nodes[0])
      span.setAttribute('dsh.surface_seq_end', nodes[nodes.length - 1])
    }
    if (typeof state.session.surface?.contentGeneration === 'number') {
      span.setAttribute('dsh.surface_generation', state.session.surface.contentGeneration)
    }
    if (typeof state.lastEventSeq === 'number') span.setAttribute('dsh.event_seq', state.lastEventSeq)
  }

  private createSettledChat(state: SessionState, event: DurableEvent): ChatSpan {
    const data = event.data
    const startedAt = firstStreamTime(data.stream) ?? event.time
    const span = this.tracer.startSpan(
      state.model ? `chat ${state.model}` : 'chat',
      { startTime: startedAt, attributes: this.chatAttributes(state, data.turn, data.step) },
      this.parentContext(state),
    )
    const chat: ChatSpan = {
      span,
      context: span.spanContext(),
      turn: data.turn,
      step: data.step,
      startedAt,
    }
    const key = stateKey(state.session.id, data.turn, data.step)
    const queue = state.chatQueueByStep.get(key) ?? []
    queue.push(chat)
    state.chatQueueByStep.set(key, queue)
    state.lastChatByStep.set(key, chat)
    return chat
  }

  private finishChat(state: SessionState, chat: ChatSpan, at: number): void {
    if (!chat.span.isRecording()) return
    chat.span.end(time(at))
    if (chat.attemptId) state.chatByAttempt.delete(chat.attemptId)
    const key = stateKey(state.session.id, chat.turn, chat.step)
    const queue = state.chatQueueByStep.get(key)
    if (queue) {
      const index = queue.indexOf(chat)
      if (index >= 0) queue.splice(index, 1)
      if (queue.length === 0) state.chatQueueByStep.delete(key)
    }
  }

  /**
   * Tool spans nest under the agent root, not the chat span that requested the call. The chat
   * span closes when the model stream ends, so a tool that runs after it starts outside the
   * parent interval and breaks the backend waterfall.
   */
  private startTool(state: SessionState, event: DurableEvent): void {
    const data = event.data
    const callId = String(data.callId)
    const span = this.tracer.startSpan(
      `execute_tool ${data.name}`,
      {
        startTime: time(event.time),
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': String(data.name),
          'gen_ai.tool.call.id': callId,
          'gen_ai.conversation.id': state.session.id,
          'dsh.turn': data.turn,
          'dsh.step': data.step,
          ...(this.config.captureToolArguments
            ? { 'gen_ai.tool.call.arguments': capturedToolArguments(String(data.arguments ?? ''), this.config) }
            : {}),
        },
      },
      this.parentContext(state),
    )
    state.tools.set(callId, { span, turn: data.turn, step: data.step })
  }

  private endTool(state: SessionState, event: DurableEvent): void {
    // `toolCallId` and `isError` are top-level fields of ToolResultMessage, not content block fields.
    const callId = String(event.data.message?.toolCallId ?? '')
    const tool = state.tools.get(callId)
    if (!tool) return
    if (event.data.message?.isError || event.data.error) {
      tool.span.setAttribute('error.type', event.data.error?.code ?? 'tool_error')
      tool.span.setStatus({ code: SpanStatusCode.ERROR })
    }
    this.finishTool(state, tool, event.time)
    state.tools.delete(callId)
  }

  private finishTool(state: SessionState, tool: ToolSpan, at: number, error?: string): void {
    if (!tool.span.isRecording()) return
    if (error) {
      tool.span.setAttribute('error.type', error)
      tool.span.setStatus({ code: SpanStatusCode.ERROR })
    }
    tool.span.end(time(at))
    for (const [id, value] of state.tools) if (value === tool) state.tools.delete(id)
  }
}
