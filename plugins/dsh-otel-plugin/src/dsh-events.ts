/**
 * DSH session event vocabulary, classified for ref resync decisions.
 *
 * `KNOWN_SESSION_EVENT_TYPES` mirrors the generated catalog in
 * `@deepseek-ai/dsh-session/lib/types/known-event-types.js`. The copy is pinned by a
 * test against the installed catalog, and an event the plugin does not know triggers a
 * resync, so a catalog this plugin has fallen behind on costs bytes, never a broken history.
 *
 * @module
 */

/** Why a span republished the full ordered ref list. */
export type ResyncReason =
  | 'session_start'
  | 'watchdog'
  | 'prefix_broken'
  | 'user_message'
  | 'prompt_sections'
  | 'tool_set'
  | 'route'
  | 'compaction'
  | 'feedback'
  | 'splice'
  | 'seed'
  | 'surface_replace'
  | 'runtime_context'
  | 'turn_root'
  | 'export_gap'
  | 'unknown_event'

/** Session event types whose content the model sees, so the history they touch resyncs. */
export const INPUT_SHAPING_EVENTS: Record<string, ResyncReason> = {
  'system/message': 'prompt_sections',
  'developer/message': 'tool_set',
  'agent/inbox/spliced': 'splice',
  'session/end-seed': 'seed',
  'compaction/start': 'compaction',
  'compaction/prune': 'compaction',
  'compaction/summary': 'compaction',
  'compaction/end': 'compaction',
  'feedback/message-put': 'feedback',
  'feedback/message-delete': 'feedback',
  'image/offload': 'surface_replace',
  'request/header': 'tool_set',
  'request/context': 'route',
  'model/selection': 'route',
  'agent-preset/selected': 'route',
  'subagent/model-selection-policy': 'route',
  'working-directory/change': 'prompt_sections',
  'sandbox/mode': 'prompt_sections',
  'approval/policy': 'prompt_sections',
  'permission/preset': 'prompt_sections',
  'plan/mode': 'prompt_sections',
  'goal/change': 'prompt_sections',
  'todo/write': 'prompt_sections',
  'subagent/catalog': 'prompt_sections',
  'subagent/descriptor': 'prompt_sections',
  'team/member': 'prompt_sections',
}

/** Session event types that never change model-visible input. */
export const NON_INPUT_EVENTS = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'user/message',
  'approval/asked',
  'approval/decided',
  'job/registered',
  'job/settled',
  'command/run',
  'command/done',
  'hook/invoked',
  'hook/result',
  'session/title',
  'session/title-llm-request',
  'deliverables/presented',
  'tool-workflow/run-start',
  'tool-workflow/run-end',
  'tool-workflow/agent-start',
  'tool-workflow/agent-end',
  'llm/retry',
  'llm/retry-started',
  'schedule/change',
  'feedback/record',
  'web/deepseek-search-llm-request',
  'workspace/changes',
  'team/message/queued',
  'team/message/delivered',
  'team/task',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'session-log-deepseek/delivery-accepted',
])

/** `resyncOn` config name to the `dsh.resync_reason` value it enables. */
export const TRIGGER_REASON: Record<string, ResyncReason> = {
  userMessage: 'user_message',
  promptSections: 'prompt_sections',
  toolSet: 'tool_set',
  route: 'route',
  compaction: 'compaction',
  feedback: 'feedback',
  splice: 'splice',
  seed: 'seed',
  surfaceReplace: 'surface_replace',
  runtimeContext: 'runtime_context',
  turnRoot: 'turn_root',
  exportGap: 'export_gap',
  unknownEvent: 'unknown_event',
}

/** The event catalog this build understands, mirrored from DSH. */
export const KNOWN_SESSION_EVENT_TYPES = new Set<string>([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'developer/message',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'job/registered',
  'job/settled',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
  'working-directory/change',
  'workspace/changes',
])

/** `true` for a type this build classifies, including out-of-repo `plugin:` records. */
export function isKnownEventType(type: string): boolean {
  return KNOWN_SESSION_EVENT_TYPES.has(type) || type.startsWith('plugin:')
}

/** `true` when `prefix` is the leading run of `list`, the append-only invariant. */
export function isPrefixOf(prefix: readonly string[], list: readonly string[]): boolean {
  if (prefix.length > list.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== list[index]) return false
  }
  return true
}
