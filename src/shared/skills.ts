import { isRecord } from './value-utils.js'

export type DecisionFormat = 'typesafe' | 'openai'
export interface DecisionSettings {
  enabled: boolean
  useMainConnection: boolean
  format: DecisionFormat
  baseUrl: string
  model: string
}
export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  enabled: false, useMainConnection: true, format: 'typesafe', baseUrl: '', model: '',
}
export interface SkillSummary {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
}
export interface SkillCatalog { skills: SkillSummary[]; revision: string; complete: boolean }
export interface ChatContextMessage { role: 'user' | 'assistant'; text: string }
export interface SkillDraft {
  sessionId: string
  revision: number
  prompt: string
  recentChat: ChatContextMessage[]
}
export interface SkillOverrides { include: string[]; exclude: string[] }
export interface SkillTurnSelection extends SkillOverrides { prompt: string; manual?: string[] }
export interface SkillSuggestions {
  sessionId: string
  revision: number
  selected: string[]
  probabilities: Record<string, number>
  threshold?: number
  elapsedMs?: number
  status: 'checking' | 'ready' | 'unavailable' | 'disabled'
  message?: string
}
export function isDecisionSettings(value: unknown): value is DecisionSettings {
  return isRecord(value) && typeof value.enabled === 'boolean' && typeof value.useMainConnection === 'boolean' &&
    (value.format === 'typesafe' || value.format === 'openai') && typeof value.baseUrl === 'string' && typeof value.model === 'string'
}
export function decisionEndpoint(baseUrl: string, format: DecisionFormat): string {
  const url = new URL(baseUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Decisions API base URL must be an HTTP(S) URL without credentials, query, or fragment.')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}/${format === 'typesafe' ? 'systemone' : 'decisions'}`
  return url.toString()
}
export function isSkillOverrides(value: unknown): value is SkillOverrides {
  return isRecord(value) && ['include', 'exclude'].every((key) => Array.isArray(value[key]) &&
    value[key].length <= 1000 && value[key].every((name: unknown) => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)))
}
export function isSkillDraft(value: unknown): value is SkillDraft {
  return isRecord(value) && typeof value.sessionId === 'string' && Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 && typeof value.prompt === 'string' && Array.isArray(value.recentChat) &&
    value.recentChat.length <= 6 && value.recentChat.every((entry: unknown) => isRecord(entry) &&
      (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string') &&
    value.recentChat.reduce((total: number, entry: ChatContextMessage) => total + entry.text.length, 0) <= 6000
}
export function recentChatContext(messages: readonly ChatContextMessage[]): ChatContextMessage[] {
  let remaining = 6000
  return [...messages.slice(-6)].reverse().map((entry) => {
    const text = remaining > 0 ? entry.text.slice(-remaining) : ''
    remaining -= text.length
    return { role: entry.role, text }
  }).reverse().filter((entry) => entry.text.length > 0)
}
export function effectiveSkills(selected: readonly string[], overrides: SkillOverrides): string[] {
  const excluded = new Set(overrides.exclude)
  return [...new Set([...selected, ...overrides.include])].filter((name) => !excluded.has(name))
}
