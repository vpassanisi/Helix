import { projectToolPresentation, type ToolPresentation } from '../shared/tool-presentation.js'
import { stringValue } from '../shared/value-utils.js'

/**
 * The presenter seam.
 *
 * A DSH tool describes its own calls through `ToolDefinition.presentCall`, and
 * the tool registry resolves a definition as one scope sees it:
 * `tools.get(name, agent)`. Both live in the runtime process, and Helix's
 * Webview is not a DSH client, so this bridge is what makes the two meet. It
 * runs on the around-dispatch hook, where the arguments are parsed, frozen, and
 * schema-accepted, projects the presenter's view down to the wire shape, and
 * emits one event per call.
 *
 * Nothing here is load-bearing for the call: a tool without a presenter, a
 * presenter that returns nothing, and a presenter that throws all publish
 * nothing, and the Webview card keeps the shape it has today.
 */
export class DshToolPresentationBridge {
  constructor(
    private readonly ctx: any,
    private readonly isAvailable: () => boolean,
    private readonly emit: (sessionId: string, method: 'tool.presentation', params: Record<string, unknown>) => boolean,
  ) {}

  /** Around-dispatch observer: publish, then let the call run untouched. */
  execute = (exec: any, next: () => Promise<unknown>): Promise<unknown> => {
    this.publish(exec)
    return next()
  }

  private publish(exec: any): void {
    if (!this.isAvailable()) return
    const name = stringValue(exec?.name)
    const callId = stringValue(exec?.callId)
    const sessionId = stringValue(exec?.agent?.id)
    if (name === undefined || callId === undefined || sessionId === undefined) return

    const view = this.presentCall(name, exec.agent, exec.arguments)
    if (view === undefined) return
    this.emit(sessionId, 'tool.presentation', { callId, name, view })
  }

  /** The definition the calling agent resolves, so the card matches the tool that ran. */
  private presentCall(name: string, scope: unknown, args: unknown): ToolPresentation | undefined {
    try {
      const tools = this.ctx?.get?.('tools') ?? this.ctx?.tools
      const tool = typeof tools?.get === 'function' ? tools.get(name, scope) : undefined
      if (typeof tool?.presentCall !== 'function') return undefined
      return projectToolPresentation(tool.presentCall(args))
    } catch {
      // A presenter is documented pure: a throw is a tool defect, and a card
      // must not lose its label because one tool has a bug.
      return undefined
    }
  }
}
