import { apply as registerAskUser } from '@deepseek-ai/dsh-tool-ask-user'

// The SDK profile includes userQuestions, but unlike agent presets it omits this tool.
export const inject = ['tools', 'userQuestions']
export function apply(ctx: any): void {
  if (!ctx.tools.get('ask_user_question')) registerAskUser(ctx)
}
