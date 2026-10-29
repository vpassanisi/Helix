import { defineTool } from '@deepseek-ai/dsh-tools'
import { REPORT_PROGRESS_DESCRIPTION, REPORT_PROGRESS_LIMIT, REPORT_PROGRESS_TOOL_NAME, parseReportProgressCall } from '../shared/report-progress.js'

/**
 * `report_progress`: the agent's note to the user lands in the transcript as
 * plain text, and the call itself stays out of the way.
 *
 * The tool answers with an acknowledgment rather than the note: the user is
 * already reading it, and handing the same sentence back is context for free.
 * A child agent has no transcript of the user's to write into, so its notes
 * would be lost, and the tool says so instead of pretending.
 */
interface ReportProgressPluginConfig {
  /** False when the Progress updates bundle is switched off in Helix's Tools page. */
  enabled?: boolean
}

export const inject = ['tools']

export function apply(ctx: any, config: ReportProgressPluginConfig = {}): void {
  if (config.enabled === false) return

  const agents = () => ctx.get?.('agents') ?? ctx.agents

  const assertRoot = (agent: any): void => {
    const registry = agents()
    if (!agent || registry?.get?.(agent.id) !== agent || !registry?.roots?.().includes(agent)) {
      throw new Error('Only the main agent can report progress. Report the update you wanted to send to your parent agent.')
    }
  }

  ctx.tools.register(defineTool({
    name: REPORT_PROGRESS_TOOL_NAME,
    description: REPORT_PROGRESS_DESCRIPTION,
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: `The update the user reads, in one or two short sentences: what you just did or what you are doing next. Not the answer to the task, and under ${REPORT_PROGRESS_LIMIT} characters.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shown: { type: 'boolean', required: true, description: 'True once the note is in the chat.' },
          characters: { type: 'integer', required: true, description: 'How long the note was.' },
        },
      },
      render: (_args: unknown, _value: unknown) => [
        { type: 'text', text: 'Progress note shown to the user. Do not repeat it in prose; keep working.' },
      ],
    },
    async execute(args: { message?: string }, exec: any) {
      assertRoot(exec?.agent)
      const call = parseReportProgressCall(args)
      if (!call.ok) throw new Error(call.message)
      return { shown: true, characters: call.text.length }
    },
  }))
}
