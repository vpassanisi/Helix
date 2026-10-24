import { isRecord } from './value-utils.js'

export interface UserQuestion {
  id: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  /** Marks a runtime-owned decision, so each boundary validates it with that decision's rules. */
  intent?: 'plan-review'
  /** The plan under review, on a `plan-review` question. */
  detail?: string
  /** The asker's own approve label; the answer must echo it verbatim. */
  approveLabel?: string
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

/**
 * A plan-mode review is not an `ask_user_question` call: it carries the plan as `detail`,
 * offers the asker's own two labels, and answers by naming one of them verbatim. Validate
 * that contract, and never the Helix house rules for model-authored questions — a plan
 * review is a fixed decision, so no `(Recommended)` marker and no label rewriting.
 *
 * Both boundaries validate, so the input is either the asker's raw question, where the
 * intent is the object `{ kind: 'plan-review', approve }`, or the normalized Helix
 * question, where it is the string `'plan-review'` beside `approveLabel`. The output is
 * the normalized form, so re-validating it changes nothing.
 */
export function validatePlanReviewQuestion(value: unknown): UserQuestion {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() ||
      typeof value.question !== 'string' || !value.question.trim()) {
    throw new Error('Plan review requires a nonempty question and id.')
  }
  const intent = value.intent
  const approve = (isRecord(intent) && intent.kind === 'plan-review' && typeof intent.approve === 'string' && intent.approve.trim())
    ? intent.approve
    : (intent === 'plan-review' && typeof value.approveLabel === 'string' && value.approveLabel.trim())
      ? value.approveLabel
      : ''
  if (!approve) {
    throw new Error('Plan review requires a plan-review intent naming its approve option.')
  }
  if (typeof value.detail !== 'string' || !value.detail.trim()) {
    throw new Error('Plan review requires the plan text in detail.')
  }
  if (value.multi_select === true || value.multiSelect === true) {
    throw new Error('Plan review is a single decision; it cannot be multi-select.')
  }
  if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 2) {
    throw new Error('Plan review offers the approve option and at most one alternative.')
  }
  const options = value.options.map((option) => {
    if (!isRecord(option) || typeof option.label !== 'string' || !option.label.trim() ||
        (option.description !== undefined && typeof option.description !== 'string')) {
      throw new Error('Each plan review option requires a nonempty label and an optional text description.')
    }
    return { label: option.label, ...(option.description === undefined ? {} : { description: option.description }) }
  })
  if (!options.some((option) => option.label === approve)) {
    throw new Error(`Plan review approve option "${approve}" names none of its options.`)
  }
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw new Error('Plan review options must have distinct labels.')
  }
  if (value.header !== undefined && typeof value.header !== 'string') throw new Error('Plan review header must be text.')
  return { id: value.id, question: value.question, options, detail: value.detail,
    intent: 'plan-review', approveLabel: approve,
    ...(typeof value.header === 'string' ? { header: value.header } : {}) }
}

/** True when a question is the plan-mode review, at every boundary that forwards it. */
export function isPlanReview(value: unknown): boolean {
  return isRecord(value) && value.intent === 'plan-review'
}

/**
 * True for the raw `exit_plan_mode` request, where the intent is the asker's own object
 * (`{ kind, approve, callId }`); the question Helix forwards after validation carries the
 * normalized `intent: 'plan-review'` string instead.
 */
export function isPlanReviewRequest(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.questions)) return false
  const question: unknown = value.questions[0]
  return isRecord(question) && isRecord(question.intent) && question.intent.kind === 'plan-review'
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
