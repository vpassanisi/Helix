import { tick } from 'svelte'
import { commandLine, commandLineHtml } from '../../shared/commands.js'
import { CompactionHistory, type CompactionEntry } from '../../shared/compaction-history.js'
import { assistantTextBlocks } from '../../shared/harness-events.js'
import type { UserQuestionView } from '../../shared/user-question.js'
import type { GenUiView } from '../../shared/gen-ui.js'
import type { ApprovalView, ChatMessage, ChatRole, CodeChange, SelectionMetadata, ToolCallView } from '../types.js'

export type StreamRole = 'assistant' | 'reasoning'

/**
 * Owns the transcript: the message list, the thinking marker, the compaction
 * entries, and the follow-bottom scroll. `onActivity` reports that model output
 * arrived so the caller can drop its own waiting-for-first-response flag.
 */
export class ChatTranscript {
  messages = $state<ChatMessage[]>([])
  activeThinkingId = $state<number | undefined>()
  transcriptElement = $state<HTMLDivElement | undefined>()
  followTranscript = true
  readonly compactionHistory = new CompactionHistory()

  readonly waitingForAnswer = $derived(this.messages.some((message) => message.tool?.question?.status === 'pending' || message.tool?.question?.status === 'submitting'))

  private nextMessageId = 1
  private thinkingSessionId: string | undefined

  constructor(private readonly onActivity: () => void) {}

  appendMessage(role: ChatRole, label: string, text: string, context?: SelectionMetadata, browserLabels?: string[]): number {
    this.finishThinking()
    if (role !== 'user') this.onActivity()
    const id = this.nextMessageId++
    this.messages = [...this.messages, { id, role, label, text, context, browserLabels }]
    void this.scrollToBottom()
    return id
  }

  /**
   * The transcript line for a run command: a normal user turn whose `/name`
   * token is gold, so a command the user typed reads as what they typed.
   */
  appendCommand(name: string, args: string): void {
    this.finishThinking()
    this.messages = [...this.messages, {
      id: this.nextMessageId++,
      role: 'user',
      label: 'You',
      text: commandLine(name, args),
      html: commandLineHtml(name, args),
    }]
    void this.scrollToBottom()
  }

  /**
   * The rule across the transcript that marks a plan mode switch, labelled with
   * the mode that took effect.
   */
  appendPlanRule(active: boolean): void {
    this.messages = [...this.messages, {
      id: this.nextMessageId++,
      role: 'divider',
      label: 'Plan Mode',
      text: active ? 'Plan Mode' : 'Plan Mode Off',
    }]
    void this.scrollToBottom()
  }

  appendChanges(changes: CodeChange[], open: boolean): void {
    this.messages = [...this.messages, {
      id: this.nextMessageId++,
      role: 'changes',
      label: 'Changes',
      text: '',
      changes: changes.map((change) => ({ ...change })),
      panelOpen: open,
    }]
  }

  /**
   * A card the agent drew with `show_ui`. It is its own transcript row, not a
   * tool row: what the user reads is the UI, and the tool call behind it has
   * nothing to show.
   */
  appendUi(view: GenUiView): void {
    this.finishThinking()
    this.messages = [...this.messages, {
      id: this.nextMessageId++,
      role: 'ui',
      label: view.title ?? 'Card',
      text: '',
      ui: { ...view },
    }]
    void this.scrollToBottom()
  }

  /** True when a call id belongs to a card, so its tool result does not open a tool row. */
  hasUi(callId: string): boolean {
    return this.messages.some((message) => message.ui?.callId === callId)
  }

  updateUi(callId: string, patch: Partial<GenUiView>): void {
    this.messages = this.messages.map((message) =>
      message.ui?.callId === callId ? { ...message, ui: { ...message.ui, ...patch } } : message)
  }

  appendStreamText(role: StreamRole, text: string, sessionId?: string): void {
    if (!text) return
    if (role === 'assistant') this.finishThinking()
    this.onActivity()
    const last = this.messages[this.messages.length - 1]
    if (last?.role === role) {
      this.messages = [...this.messages.slice(0, -1), { ...last, text: last.text + text }]
    } else {
      this.messages = [...this.messages, {
        id: this.nextMessageId++,
        role,
        label: role === 'reasoning' ? 'Thinking' : 'Helix',
        text,
      }]
    }
    if (role === 'reasoning' && sessionId !== undefined) {
      this.activeThinkingId = this.messages[this.messages.length - 1].id
      this.thinkingSessionId = sessionId
    }
    void this.scrollToBottom()
  }

  appendAssistantBlocks(content: unknown): void {
    for (const block of assistantTextBlocks(content)) this.appendStreamText(block.role, block.text)
  }

  finishThinking(sessionId?: string): void {
    if (sessionId !== undefined && sessionId !== this.thinkingSessionId) return
    this.activeThinkingId = undefined
    this.thinkingSessionId = undefined
  }

  updateCompaction(entry: CompactionEntry): void {
    const existing = this.messages.find((message) => message.compaction?.key === entry.key)
    if (existing) {
      this.messages = this.messages.map((message) => message.id === existing.id ? { ...message, compaction: entry } : message)
    } else {
      this.messages = [...this.messages, { id: this.nextMessageId++, role: 'compaction', label: 'Context', text: '', compaction: entry }]
    }
    void this.scrollToBottom()
  }

  interruptCompaction(sessionId?: string, error?: string): void {
    for (const entry of this.compactionHistory.interrupt(sessionId, error)) this.updateCompaction(entry)
  }

  upsertToolCall(tool: ToolCallView): void {
    this.finishThinking()
    this.onActivity()
    const index = this.messages.findIndex((message) => message.tool?.callId === tool.callId)
    if (index === -1) {
      this.messages = [...this.messages, { id: this.nextMessageId++, role: 'tool', label: 'Tool', text: '', tool }]
      void this.scrollToBottom()
      return
    }
    const next = [...this.messages]
    const existing = next[index].tool
    if (!existing) return
    next[index] = { ...next[index], tool: { ...existing, ...tool } }
    this.messages = next
    void this.scrollToBottom()
  }

  updateToolResult(callId: string, result: string, error?: string, meta?: string): void {
    const index = this.messages.findIndex((message) => message.tool?.callId === callId)
    if (index === -1) {
      this.upsertToolCall({
        callId,
        name: 'Tool result',
        arguments: '',
        result,
        meta,
        error,
        status: error ? 'error' : 'completed',
      })
      return
    }

    const next = [...this.messages]
    const existing = next[index].tool
    if (!existing) return
    next[index] = {
      ...next[index],
      tool: {
        ...existing,
        result,
        meta,
        error,
        status: error ? 'error' : 'completed',
      },
    }
    this.messages = next
    void this.scrollToBottom()
  }

  removePreparingToolCalls(callIds: string[]): void {
    if (callIds.length === 0) return
    const discarded = new Set(callIds)
    this.messages = this.messages.filter((entry) => entry.tool?.status !== 'preparing' || !discarded.has(entry.tool.callId))
  }

  attachApproval(callId: string, toolName: string, approval: ApprovalView): void {
    const index = this.messages.findIndex((entry) => entry.tool?.callId === callId)
    if (index === -1) {
      this.upsertToolCall({ callId, name: toolName, arguments: '', status: 'running', approval })
      return
    }

    const next = [...this.messages]
    const tool = next[index].tool
    if (!tool) return
    next[index] = { ...next[index], tool: { ...tool, approval } }
    this.messages = next
    void this.scrollToBottom()
  }

  updateToolApproval(requestId: string, status: ApprovalView['status']): void {
    const index = this.messages.findIndex((entry) => entry.tool?.approval?.requestId === requestId)
    if (index === -1) return
    const next = [...this.messages]
    const tool = next[index].tool
    if (!tool?.approval) return
    next[index] = {
      ...next[index],
      tool: { ...tool, approval: { ...tool.approval, status, decisionPending: false } },
    }
    this.messages = next
    void this.scrollToBottom()
  }

  /** Marks the decision as sent and returns the request id to post, when the tool is still waiting. */
  markApprovalPending(tool: ToolCallView): string | undefined {
    if (tool.approval?.status !== 'pending' || tool.approval.decisionPending) return undefined
    const index = this.messages.findIndex((entry) => entry.tool?.callId === tool.callId)
    if (index === -1) return undefined
    const next = [...this.messages]
    const current = next[index].tool
    if (!current?.approval) return undefined
    const requestId = current.approval.requestId
    next[index] = {
      ...next[index],
      tool: { ...current, approval: { ...current.approval, decisionPending: true } },
    }
    this.messages = next
    return requestId
  }

  hasQuestion(requestId: string): boolean {
    return this.messages.some((message) => message.tool?.question?.requestId === requestId)
  }

  updateQuestion(requestId: string, update: Partial<UserQuestionView>): void {
    this.messages = this.messages.map((message) => message.tool?.question?.requestId === requestId
      ? { ...message, tool: { ...message.tool, question: { ...message.tool.question, ...update } } } : message)
  }

  endPendingQuestions(): void {
    for (const message of this.messages) {
      const question = message.tool?.question
      if (question?.status === 'pending' || question?.status === 'submitting') this.updateQuestion(question.requestId, { status: 'cancelled' })
    }
  }

  /** Ids for synthetic tool calls that never became a transcript message. */
  allocateId(): number {
    return this.nextMessageId++
  }

  discardMessage(id: number): void {
    this.messages = this.messages.filter((entry) => entry.id !== id)
  }

  /** User and assistant turns, in order, for the skill routing draft. */
  chatTurns(): Array<{ role: 'user' | 'assistant'; text: string }> {
    return this.messages
      .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
      .map((entry) => ({ role: entry.role as 'user' | 'assistant', text: entry.text }))
  }

  reset(): void {
    this.finishThinking()
    this.compactionHistory.reset()
    this.followTranscript = true
    this.messages = []
  }

  onScroll(event: Event): void {
    this.followTranscript = isNearBottom(event.currentTarget as HTMLDivElement)
  }

  async scrollToBottom(): Promise<void> {
    if (!this.followTranscript) return
    await tick()
    if (this.followTranscript && this.transcriptElement) this.transcriptElement.scrollTop = this.transcriptElement.scrollHeight
  }
}

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= 24
}
