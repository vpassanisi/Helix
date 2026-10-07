import { isRecord } from './value-utils.js'

export interface UserQuestion {
  id: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
}

export interface UserQuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

export interface PendingUserQuestion {
  sessionId: string
  requestId: string
  toolCallId: string
  question: UserQuestion
}

export interface UserQuestionView extends PendingUserQuestion {
  status: 'pending' | 'submitting' | 'answered' | 'cancelled' | 'unavailable'
  answer?: UserQuestionAnswer
  error?: string
}

export const USER_QUESTION_INSTRUCTIONS = 'When a material ambiguity or unexpected finding requires a user decision, call ask_user_question before proceeding. Ask exactly one concise question per call. Provide 2 or 3 distinct options, with exactly one recommended option first and "(Recommended)" appended to its label. Do not use multi_select. Helix supplies a custom-response input automatically; do not include it among your options. Wait for the answer; never infer approval from waiting or cancellation. Child agents must report unresolved decisions to the main agent instead of asking the user.'

export function optionDisplayLabel(label: string): string {
  return label.replace(/\s*\(Recommended\)$/, '')
}

/** Validate at both runtime and UI transport boundaries; never display a malformed call. */
export function validateUserQuestion(value: unknown): UserQuestion {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() ||
      typeof value.question !== 'string' || !value.question.trim()) {
    throw new Error('ask_user_question requires a nonempty question and id.')
  }
  if ((value.multi_select !== undefined && value.multi_select !== false) ||
      (value.multiSelect !== undefined && value.multiSelect !== false)) {
    throw new Error('ask_user_question supports single selection only; omit multi_select or set it to false.')
  }
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 3) {
    throw new Error('ask_user_question requires 2 or 3 options.')
  }
  const options = value.options.map((option) => {
    if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim() ||
        (option.description !== undefined && typeof option.description !== 'string')) {
      throw new Error('Each question option requires a nonempty label and an optional text description.')
    }
    return { label: option.label, ...(option.description === undefined ? {} : { description: option.description }) }
  })
  const recommended = options.flatMap((option) => option.label.match(/\(Recommended\)/g) ?? [])
  if (recommended.length !== 1 || !options[0].label.endsWith('(Recommended)')) {
    throw new Error('Exactly one option must be recommended: put it first and append "(Recommended)" to its label.')
  }
  const labels = options.map((option) => optionDisplayLabel(option.label).trim().toLowerCase())
  if (labels.some((label) => !label) || new Set(labels).size !== labels.length) {
    throw new Error('Question options must have distinct, nonempty labels.')
  }
  if (value.header !== undefined && typeof value.header !== 'string') throw new Error('Question header must be text.')
  return { id: value.id, question: value.question, options,
    ...(typeof value.header === 'string' ? { header: value.header } : {}) }
}

export function validateQuestionCall(value: unknown): UserQuestion {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length !== 1) {
    throw new Error('ask_user_question must ask exactly one question per call.')
  }
  return validateUserQuestion(value.questions[0])
}

export function validateQuestionAnswer(question: UserQuestion, value: unknown): UserQuestionAnswer {
  if (!isRecord(value) || value.id !== question.id || !Array.isArray(value.selected) ||
      value.selected.some((label) => typeof label !== 'string')) throw new Error('Answer does not match this question.')
  const selected = value.selected as string[]
  if (selected.length === 1 && value.custom === undefined &&
      question.options.some((option) => option.label === selected[0])) {
    return { id: question.id, selected: [selected[0]] }
  }
  if (value.selected.length === 0 && typeof value.custom === 'string' && value.custom.trim()) {
    return { id: question.id, selected: [], custom: value.custom.trim() }
  }
  throw new Error('Choose one provided option or enter a nonempty custom response.')
}
