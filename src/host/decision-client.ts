import { decisionEndpoint, type DecisionSettings, type SkillSummary } from '../shared/skills.js'
import { isRecord } from '../shared/value-utils.js'

export interface DecisionConnection extends DecisionSettings { apiKey?: string; threshold: number }
export interface DecisionAnswer { skillId: string; probability?: number }

/** Wire formats stay behind this boundary; probabilities are not a confidence score. */
export async function decideSkills(connection: DecisionConnection, input: string, skills: readonly SkillSummary[],
  signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<DecisionAnswer[]> {
  const questions = skills.map((skill) => ({
    name: skill.name,
    instructions: `Should the agent apply this skill to the current user request? Evaluate the current draft in the context of recent conversation. Answer yes only when its instructions apply.\nSkill: ${skill.name}\nDescription: ${skill.description}${skill.whenToUse ? `\nWhen to use: ${skill.whenToUse}` : ''}`,
  }))
  const body = connection.format === 'typesafe'
    ? { model: connection.model, state: input, questions: Object.fromEntries(questions.map(({ name, instructions }) => [name, { type: 'noul', instructions }])) }
    : { model: connection.model, input, questions: questions.map(({ name, instructions }) => ({ name, instructions, type: 'predicate' })) }
  const response = await fetcher(decisionEndpoint(connection.baseUrl, connection.format), {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    // Surface the API's diagnostic instead of discarding it behind the status code.
    const body: unknown = await response.json().catch(() => undefined)
    const detail = isRecord(body) ? body.detail ?? body.error : undefined
    const message = typeof detail === 'string' ? detail : isRecord(detail) && typeof detail.message === 'string' ? detail.message : undefined
    const safeMessage = message ? (connection.apiKey ? message.replaceAll(connection.apiKey, '[redacted]') : message).slice(0, 500) : undefined
    throw new Error(`Decisions endpoint returned HTTP ${response.status}.${safeMessage ? ` ${safeMessage}` : ''}`)
  }
  const result: unknown = await response.json()
  const answers = isRecord(result) ? result.answers : undefined
  return skills.map(({ name }) => {
    let answer: unknown
    if (connection.format === 'typesafe' && isRecord(answers)) answer = answers[name]
    if (connection.format === 'openai' && Array.isArray(answers)) {
      const matches = answers.filter((entry: unknown) => isRecord(entry) && entry.name === name)
      if (matches.length === 1) answer = matches[0]
    }
    const probability = isRecord(answer) && answer.type === (connection.format === 'typesafe' ? 'noul' : 'predicate')
      ? answer[connection.format === 'typesafe' ? 'noul' : 'probability'] : undefined
    return { skillId: name, ...(typeof probability === 'number' && Number.isFinite(probability) && probability >= 0 && probability <= 1 ? { probability } : {}) }
  })
}
