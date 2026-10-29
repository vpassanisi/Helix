import { isCommandName } from '../shared/commands.js'
import { stringValue } from '../shared/value-utils.js'
import type { ControlRequestEnvelope } from './control-protocol.js'
import {
  PluginControlError,
  authorityOf,
  getAgent,
  isOwnedBy,
  requireAgent,
  requiredString,
} from './dsh-control-shared.js'

/**
 * The composer's command catalog and execution, over the DSH command
 * registry. The registry's own `command/run` and `command/done` records land
 * in the session log, and `/compact` reaches the compaction seam.
 */
export class DshCommandBridge {
  constructor(
    private readonly ctx: any,
    private readonly respond: (request: ControlRequestEnvelope, result?: unknown, error?: { code: string; message: string }) => void,
    private readonly emit: (sessionId: string, method: 'commands.changed', params: Record<string, unknown>) => boolean,
  ) {}

  private commandRegistry(): any {
    const registry = this.ctx.get?.('commands') ?? this.ctx.commands
    if (registry?.list === undefined || registry?.execute === undefined) {
      throw new PluginControlError('The DSH command registry is unavailable.', 'CONTROL_REQUEST_FAILED')
    }
    return registry
  }

  /**
   * Registry descriptors are handler-free views. A definition owned by the
   * deployment is a Harness command; anything else was registered for this
   * workspace, which is the label the composer shows.
   */
  private commandDescriptor(descriptor: any): Record<string, string> | undefined {
    const name = stringValue(descriptor?.name)
    const description = stringValue(descriptor?.description)
    if (name === undefined || !isCommandName(name) || description === undefined) return undefined
    const hint = stringValue(descriptor?.input?.hint)
    const definitionId = stringValue(descriptor?.definitionId)
    return {
      name,
      description,
      ...(hint === undefined ? {} : { hint }),
      source: definitionId !== undefined && !definitionId.startsWith('@deepseek-ai/') ? 'workspace' : 'harness',
    }
  }

  /**
   * The composer opens its popup before a chat has an Agent: a Helix session is
   * minted here and reaches DSH with its first prompt. The registry's global
   * scope is what a deployment registers, so a session that is not live yet
   * lists that view, and `agent/created` reloads it with the Agent's own scoped
   * commands on top.
   */
  catalog = (request: ControlRequestEnvelope): void => {
    const agent = getAgent(this.ctx, request.sessionId)
    const authoritySessionId = authorityOf(request)
    if (agent !== undefined && !isOwnedBy(this.ctx, agent, authoritySessionId)) {
      throw new PluginControlError(`Session ${request.sessionId} is not owned by ${authoritySessionId}.`, 'SESSION_NOT_OWNED')
    }
    const commands = this.commandRegistry().list(agent)
    this.respond(request, {
      available: true,
      commands: (Array.isArray(commands) ? commands : []).map(this.commandDescriptor).filter((entry) => entry !== undefined),
    })
  }

  /**
   * Run one composer command through the Host registry, so the session log
   * carries its `command/run` and `command/done` pair and `/compact` reaches the
   * compaction seam the registry's own definition calls.
   */
  run = async (request: ControlRequestEnvelope): Promise<void> => {
    const name = requiredString(request.params.name, 'name')
    if (!isCommandName(name)) throw new PluginControlError('The command name is not valid.', 'INVALID_ARGUMENT')
    const agent = requireAgent(this.ctx, request, `/${name} needs a chat that has started. Send a message first.`)
    const args = stringValue(request.params.args)?.trim()
    const execution = await this.commandRegistry().execute(agent, args ? `/${name} ${args}` : `/${name}`, [], new AbortController().signal)
    if (execution === undefined) throw new PluginControlError(`/${name} is not a command.`, 'INVALID_ARGUMENT')
    const text = stringValue(execution.result?.text)
    const commandId = stringValue(execution.commandId)
    this.respond(request, {
      kind: execution.result?.kind === 'error' ? 'error' : 'success',
      ...(text === undefined ? {} : { text }),
      ...(commandId === undefined ? {} : { commandId }),
    })
  }

  /** A deployment-level registry change re-lists every composer. */
  globalChange = (): void => {
    this.emit('', 'commands.changed', {})
  }

  /** An Agent arriving adds its scoped layer, so the composer lists again. */
  agentCreated = ({ agent }: any): void => {
    const sessionId = stringValue(agent?.id)
    if (sessionId !== undefined) this.emit(sessionId, 'commands.changed', {})
  }
}
