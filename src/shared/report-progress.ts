import { isRecord, parsePayload } from './value-utils.js'

/** The tool an agent uses to put a short progress note in the chat and keep working. */
export const REPORT_PROGRESS_TOOL_NAME = 'report_progress'

export const REPORT_PROGRESS_DESCRIPTION =
  'Send a brief progress update to the user while continuing work. Use after several tool calls or significant milestones.'

/** One note is a line the user reads, not an answer, so the call stays a line. */
export const REPORT_PROGRESS_LIMIT = 600

export type ReportProgressCall = { ok: true; text: string } | { ok: false; message: string }

/**
 * Reads the note out of a call's arguments, which arrive as an object from the
 * tool runtime and as the streamed JSON string from a harness event.
 */
export function parseReportProgressCall(args: unknown): ReportProgressCall {
  const payload = parsePayload(args)
  if (!isRecord(payload)) return { ok: false, message: 'report_progress needs a "message" string.' }
  const text = typeof payload.message === 'string' ? payload.message.trim() : ''
  if (!text) return { ok: false, message: 'report_progress needs a non-empty "message" string.' }
  if (text.length > REPORT_PROGRESS_LIMIT) {
    return { ok: false, message: `Keep a progress note under ${REPORT_PROGRESS_LIMIT} characters and put the detail in your reply.` }
  }
  return { ok: true, text }
}
