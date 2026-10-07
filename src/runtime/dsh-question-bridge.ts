import { randomUUID } from 'node:crypto'
import { validateQuestionCall, validateQuestionAnswer, type PendingUserQuestion, type UserQuestionAnswer } from '../shared/user-question.js'

interface WaitingQuestion extends PendingUserQuestion {
  signal: AbortSignal
  abort: () => void
  resolve: (answer: { answers: UserQuestionAnswer[] }) => void
  reject: (error: Error) => void
}

/** Uses the runtime's own tool and userQuestions service, without importing another DSH instance. */
export class DshQuestionBridge {
  private readonly executions = new Map<string, { callId: string; signal: AbortSignal }>()
  private readonly waiting = new Map<string, WaitingQuestion>()

  constructor(private readonly ctx: any, private readonly connected: () => boolean,
    private readonly emit: (sessionId: string, method: 'question.request' | 'question.resolved', params: Record<string, unknown>) => boolean) {}

  private assertRoot(agent: any): void {
    const agents = this.ctx.get?.('agents') ?? this.ctx.agents
    if (!agent || agents?.get?.(agent.id) !== agent || !agents?.roots?.().includes(agent)) {
      throw new Error('Only the exact live main agent can ask the user. Child agents must report unresolved decisions to their parent.')
    }
  }

  execute = async (exec: any, next: () => Promise<any>): Promise<any> => {
    if (exec.name !== 'ask_user_question') return next()
    this.assertRoot(exec.agent)
    validateQuestionCall(exec.arguments)
    if (!this.connected()) throw new Error('Helix question UI is unavailable.')
    if (this.executions.has(exec.agent.id)) throw new Error('A user question is already running for this agent.')
    const execution = { callId: exec.callId, signal: exec.signal }
    this.executions.set(exec.agent.id, execution)
    try { return await next() } finally {
      if (this.executions.get(exec.agent.id) === execution) this.executions.delete(exec.agent.id)
    }
  }

  request = async (request: any, next: () => Promise<any>): Promise<any> => {
    const sessionId = request.agent?.id
    const execution = this.executions.get(sessionId)
    // Other consumers of userQuestions keep their own answerers.
    if (!execution) return next()
    this.assertRoot(request.agent)
    const question = validateQuestionCall(request)
    const signal: AbortSignal = request.signal ?? execution.signal
    if (signal.aborted) throw new Error('Question cancelled before the user answered.')
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const pending: WaitingQuestion = { sessionId, requestId, toolCallId: execution.callId, question, signal,
        resolve, reject, abort: () => this.finish(requestId, 'cancelled') }
      this.waiting.set(requestId, pending)
      signal.addEventListener('abort', pending.abort, { once: true })
      if (!this.connected() || !this.emit(sessionId, 'question.request', { requestId, toolCallId: execution.callId, question })) {
        this.finish(requestId, 'unavailable', undefined, true)
      }
    })
  }

  answer(sessionId: string, requestId: string, value: unknown): void {
    const pending = this.waiting.get(requestId)
    if (!pending || pending.sessionId !== sessionId) throw new Error('Question is no longer pending in this session.')
    if (pending.signal.aborted) { this.finish(requestId, 'cancelled'); throw new Error('Question was cancelled.') }
    this.assertRoot((this.ctx.get?.('agents') ?? this.ctx.agents)?.get?.(sessionId))
    this.finish(requestId, 'answered', validateQuestionAnswer(pending.question, value))
  }

  private finish(requestId: string, status: 'answered' | 'cancelled' | 'unavailable', answer?: UserQuestionAnswer, cancelTurn = false): void {
    const pending = this.waiting.get(requestId)
    if (!pending) return
    this.waiting.delete(requestId)
    pending.signal.removeEventListener('abort', pending.abort)
    this.emit(pending.sessionId, 'question.resolved', { requestId, status, ...(answer ? { answer } : {}) })
    if (cancelTurn) {
      const agent = (this.ctx.get?.('agents') ?? this.ctx.agents)?.get?.(pending.sessionId)
      agent?.cancel?.({ kind: 'user' }, { keepInbox: false })
    }
    if (answer) pending.resolve({ answers: [answer] })
    else pending.reject(new Error(status === 'cancelled' ? 'Question cancelled before the user answered.' : 'Helix question UI disconnected; the asking turn was cancelled.'))
  }

  disconnect(): void {
    for (const requestId of [...this.waiting.keys()]) this.finish(requestId, 'unavailable', undefined, true)
  }
  dispose(): void {
    for (const requestId of [...this.waiting.keys()]) this.finish(requestId, 'cancelled', undefined, true)
    this.executions.clear()
  }
}
