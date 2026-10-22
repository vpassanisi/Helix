/**
 * The model-facing tool bundles the runtime composes from its profile, listed
 * so the Webview can offer switches. A bundle id is the unit the runtime
 * patch can disable, and one package can supply several bundle ids
 * (dsh-tool-subagent provides tool-subagent and tool-subagent-fork), so the
 * list is per tool, not per package.
 */
export type ToolBundleGroup = 'files' | 'shell' | 'agents' | 'web' | 'planning' | 'context'

export interface ToolBundleOption {
  id: string
  label: string
  group: ToolBundleGroup
  /** The tools this bundle adds to the request. */
  tools: readonly string[]
  hint: string
  /** Helix fixes this bundle off, so the page cannot re-enable it. */
  locked?: 'disabled'
}

export const TOOL_BUNDLE_OPTIONS: readonly ToolBundleOption[] = [
  { id: 'tool-fs', label: 'File tools', group: 'files', tools: ['read', 'write', 'edit', 'read_image'], hint: 'Read, write, and edit files in the workspace.' },
  { id: 'tool-fs-search', label: 'Search tools', group: 'files', tools: ['glob', 'grep'], hint: 'Find files and search file contents.' },
  { id: 'tool-bash', label: 'Bash', group: 'shell', tools: ['bash'], hint: 'Run shell commands through the sandbox.' },
  { id: 'tool-pwsh', label: 'PowerShell', group: 'shell', tools: ['pwsh'], hint: 'Run PowerShell commands through the sandbox.' },
  { id: 'tool-working-directory', label: 'Working directory', group: 'shell', tools: ['working_directory'], hint: 'Read and change the working directory of a command.' },
  { id: 'tool-jobs', label: 'Background jobs', group: 'shell', tools: ['job_output', 'job_list', 'job_kill'], hint: 'Start, read, and stop background commands.' },
  { id: 'tool-subagent', label: 'Subagent', group: 'agents', tools: ['subagent'], hint: 'Delegate a self-contained task to a new agent.' },
  { id: 'tool-subagent-fork', label: 'Forked subagent', group: 'agents', tools: ['subagent_fork'], hint: 'Delegate a task that inherits this conversation.' },
  { id: 'tool-subagent-control', label: 'Subagent control', group: 'agents', tools: ['send_message', 'interrupt_agent'], hint: 'Message or stop an agent that is already running.' },
  { id: 'tool-subagent-list-agents', label: 'Subagent list', group: 'agents', tools: ['list_agents'], hint: 'List the agents started in this session.' },
  { id: 'tool-workflow', label: 'Workflow', group: 'agents', tools: ['workflow'], hint: 'Run an orchestrated script across many subagents.' },
  { id: 'tool-todo', label: 'Task list', group: 'planning', tools: ['todo_write'], hint: 'Track a task list and show progress.' },
  { id: 'tool-goal', label: 'Goal', group: 'planning', tools: ['create_goal', 'get_goal', 'update_goal'], hint: 'Keep a long-running objective across continuation rounds.' },
  { id: 'plan-mode', label: 'Plan mode', group: 'planning', tools: ['plan'], hint: 'Plan for review before an implementation runs.' },
  { id: 'tool-skill', label: 'Skills', group: 'context', tools: ['skill'], hint: 'Load the instructions of a listed skill.' },
  { id: 'mcp-resources', label: 'MCP resources', group: 'context', tools: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'], hint: 'Read resources published by the MCP servers.' },
  { id: 'user-questions', label: 'Ask the user', group: 'context', tools: ['ask_user_question'], hint: 'Ask a question and wait for the answer. Helix shows these in the chat.' },
  { id: 'tool-web', label: 'Web search and fetch', group: 'web', tools: ['web_search', 'web_fetch'], hint: 'Helix disables every web bundle for this runtime.', locked: 'disabled' },
]

const OPTIONS_BY_ID = new Map(TOOL_BUNDLE_OPTIONS.map((option) => [option.id, option]))

export function toolBundleOption(id: string): ToolBundleOption | undefined {
  return OPTIONS_BY_ID.get(id)
}

/** Keeps the ids the page knows about, drops duplicates, sorts for a stable patch. */
export function normalizeDisabledToolBundles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && OPTIONS_BY_ID.has(entry))
  return [...new Set(ids.filter((id) => toolBundleOption(id)?.locked === undefined))].sort()
}

export function toolBundleLabel(id: string): string {
  return OPTIONS_BY_ID.get(id)?.label ?? id
}

/** Patch rows that take a bundle out of the runtime. */
export function toolBundlePatchLines(disabled: readonly string[]): string[] {
  return normalizeDisabledToolBundles(disabled).flatMap((id) => [`- id: ${JSON.stringify(id)}`, '  disabled: true'])
}

/** Bundle ids the enabled options stand for, for the page summary. */
export function enabledToolNames(disabled: readonly string[]): string[] {
  const off = new Set(normalizeDisabledToolBundles(disabled))
  return TOOL_BUNDLE_OPTIONS.filter((option) => option.locked === undefined && !off.has(option.id))
    .flatMap((option) => option.tools)
}

export function disabledToolNames(disabled: readonly string[]): string[] {
  const off = new Set(normalizeDisabledToolBundles(disabled))
  return TOOL_BUNDLE_OPTIONS.filter((option) => off.has(option.id)).flatMap((option) => option.tools)
}
