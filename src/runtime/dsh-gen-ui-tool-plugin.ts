import { defineTool } from '@deepseek-ai/dsh-tools'
import { GEN_UI_LIMITS, GEN_UI_TOOL_NAME, genUiPromptText, parseGenUiCall } from '../shared/gen-ui.js'

interface GenUiPluginConfig {
  /** False when the Generative UI bundle is switched off in Helix's Tools page. */
  enabled?: boolean
}

const SHOW_UI_DESCRIPTION =
  'Render a card in the chat from the Helix component catalog: metrics, tables, progress, comparisons, statuses, pickers, checklists, forms whose buttons send messages back. Call it with a complete json-render spec. The card carries data and controls, not prose: the explanation goes in your reply before the call. The card is the response, so end the turn on it. The user sees the card; they do not see this call\u2019s arguments. Only the main agent can render, and only one card per turn.'

/**
 * `show_ui`: the model draws with the catalog Helix ships, and Helix renders
 * what comes back.
 *
 * The tool itself does two things beyond validation. It refuses a child agent,
 * because a card inside a subagent's run has no transcript to land in, and it
 * answers with a one-line summary instead of the spec: the spec is already on
 * its way to the user, and echoing it back into the context is pure waste.
 */
export const inject = ['tools']

export function apply(ctx: any, config: GenUiPluginConfig = {}): void {
  if (config.enabled === false) return

  const agents = () => ctx.get?.('agents') ?? ctx.agents

  const assertRoot = (agent: any): void => {
    const registry = agents()
    if (!agent || registry?.get?.(agent.id) !== agent || !registry?.roots?.().includes(agent)) {
      throw new Error('Only the main agent can render UI. Report the card you wanted to your parent agent.')
    }
  }

  ctx.tools.register(defineTool({
    name: GEN_UI_TOOL_NAME,
    description: SHOW_UI_DESCRIPTION,
    parameters: {
      spec: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: `A complete json-render spec: { root, elements: { key: { type, props, children, on? } }, state? }. Every component type must come from the catalog in the system prompt. Keep it under ${GEN_UI_LIMITS.maxElements} elements and ${GEN_UI_LIMITS.maxSpecCharacters} characters.`,
      },
      title: {
        type: 'string',
        description: 'Optional short heading for the card, such as "Test suite".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          displayed: { type: 'boolean', required: true, description: 'True once the card is in the transcript.' },
          elements: { type: 'integer', required: true, description: 'How many elements the card renders.' },
          title: { type: 'string', description: 'The card heading, when one was given.' },
        },
      },
      render: (_args: unknown, value: any) => [
        { type: 'text', text: `Shown to the user as a card (${String(value?.elements ?? 0)} elements). Do not repeat the card\u2019s content in prose. The card is your response: end the turn on it, with no text after.` },
      ],
    },
    async execute(args: { spec?: unknown; title?: string }, exec: any) {
      assertRoot(exec?.agent)
      const call = parseGenUiCall(args)
      if (!call.ok) throw new Error(call.message)
      const elements = Object.keys(call.spec.elements ?? {}).length
      return {
        displayed: true,
        elements,
        ...(call.title === undefined ? {} : { title: call.title }),
      }
    },
  }))

  const assemble = async (assembly: any, _context: unknown, next: () => Promise<any>) => {
    const assembled = await next()
    if (Array.isArray(assembled?.sections) && !assembled.sections.some((section: any) => section?.name === 'helix:gen-ui')) {
      assembled.sections.push({ name: 'helix:gen-ui', text: genUiPromptText() })
    }
    return assembled
  }

  ctx.on?.('system-prompt/assemble', assemble, { global: true })
}
