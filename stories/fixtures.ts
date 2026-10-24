import type { ChatMessage, CodeChange, IncomingMessage, ModelEditorDraft, SidebarDiscoveredModel, SidebarModel, McpServerDraft, RequestPreviewResult, SidebarSettings, ToolCallView } from '../src/webview/types.js'
import type { BrowserElementContext } from '../src/shared/browser-context.js'
import type { UserQuestionView } from '../src/shared/user-question.js'
import type { SkillSummary, SkillSuggestions } from '../src/shared/skills.js'
import { commandLine, commandLineHtml, type CommandCatalog, type ComposerCommand } from '../src/shared/commands.js'

export const changes: CodeChange[] = [
  { path: 'src/webview/components/ChangesPanel.svelte', kind: 'created', additions: 92, deletions: 0 },
  { path: 'src/webview/App.svelte', kind: 'modified', additions: 3, deletions: 62 },
  { path: 'src/webview/theme.css', oldPath: 'src/webview/colors.css', kind: 'renamed', additions: 0, deletions: 0 },
  { path: 'src/webview/legacy.css', kind: 'deleted', additions: 0, deletions: 24 },
]

export const models: SidebarModel[] = [
  { id: 'deepseek-v4-flash', displayName: 'DeepSeek Flash', contextWindow: 128000, acceptsImages: false, reasoningFormat: 'openai', reasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'local-coder', displayName: 'Local Coder', contextWindow: 32000, acceptsImages: true, reasoningFormat: 'qwen', binaryThinkingMode: 'on', reasoningEfforts: [] },
]
export const discoveredModels: SidebarDiscoveredModel[] = [...models, { id: 'new-coder', displayName: 'New Coder', contextWindow: 64000 }]
export const modelDrafts: ModelEditorDraft[] = models.map((model, index) => ({
  ...model, key: index + 1, sourceId: model.id, reasoningEfforts: model.reasoningEfforts ?? [],
  chatTemplateKwargsText: '{}', chatTemplateArgsText: '{}',
}))
export { modelOptionLabel } from '../src/webview/lib/model-mappers.js'

export const mcpServers: McpServerDraft[] = [
  { serverName: 'local-tools', transport: 'stdio', command: 'docker', argsText: 'run\n-i\n--rm\nexample/mcp-server', url: '', env: [{ name: 'API_TOKEN', value: '', configured: true }] },
  { serverName: 'docs', transport: 'streamable-http', command: '', argsText: '', url: 'http://localhost:3000/mcp', env: [] },
]

export const tool: ToolCallView = {
  callId: 'preview-tool', name: 'read_file', arguments: '{"path":"src/webview/App.svelte"}', status: 'completed',
  result: 'Read **App.svelte** successfully.\n\n```svelte\n<ChangesPanel changes={codeChanges} />\n```',
  meta: 'File size: 12 KB',
}

export const requestPreview: RequestPreviewResult = {
  request: {
    provider: 'llm-pi-ai', model: 'deepseek-v4-flash', reasoningEffort: 'high', temperature: 0.2, maxTokens: 2048,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are a coding assistant.\n\nWork in the current workspace.' }], source: { kind: 'plugin', plugin: 'dsh-system-prompt' } },
      { role: 'user', content: [{ type: 'text', text: 'Review the changes panel.' }], source: { kind: 'user' } },
    ],
    tools: [{ name: 'read_file', description: 'Read a file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  },
  promptBreakdown: {
    systemSections: [{ name: 'harness:identity', text: 'You are a coding assistant.' }, { name: 'workspace:instructions', text: 'Work in the current workspace.' }],
    contextSections: [],
  },
}

export const attachments: BrowserElementContext[] = [{
  id: 'preview-element', url: 'http://localhost:3000', label: 'Save button', selector: '#save',
  html: '<button id="save">Save</button>', css: 'button { border-radius: 8px; }',
  dimensions: { top: 20, left: 10, width: 80, height: 30 }, truncated: false,
}]

export const question: UserQuestionView = {
  sessionId: 'preview', requestId: 'preview-question', toolCallId: 'preview-question-tool', status: 'pending',
  question: { id: 'scope', header: 'Scope', question: 'Which changes should be included?', options: [
    { label: 'Current component (Recommended)', description: 'Keep the change focused on this component.' },
    { label: 'All components', description: 'Apply the change throughout the webview.' },
  ] },
}

/** The plan-mode review, as `exit_plan_mode` sends it: the whole plan rides in `detail`. */
export const planReview: UserQuestionView = {
  sessionId: 'preview', requestId: 'preview-plan-review', toolCallId: 'preview-plan-review-tool', status: 'pending',
  question: {
    id: 'plan-review', header: 'Plan review', intent: 'plan-review', approveLabel: 'Approve',
    question: 'Approve this plan and leave plan mode?',
    detail: `# Tighten the settings header

Make the sticky settings header — the back button plus page title — match the chat masthead.

## Change 1 — \`src/webview/app.css\`

- \`padding: 16px 14px 10px\` → \`4px 14px\`
- \`align-items: flex-start\` → \`center\`

## Verification

1. Measure \`.settings-heading\` in Storybook: 36px, like \`.masthead\`.
2. \`npm run build:webview\`.
3. Bump the patch version.
`,
    options: [
      { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
      { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
    ],
  },
}

export const skills: SkillSummary[] = [
  { name: 'frontend', description: 'Build and refine frontend interfaces.', modelInvocable: true, userInvocable: true },
  { name: 'basecoat', description: 'Use the existing Basecoat components.', modelInvocable: true, userInvocable: true },
  { name: 'better-writing', description: 'Write clear, concise prose.', modelInvocable: true, userInvocable: true },
]
export const suggestions: SkillSuggestions = {
  sessionId: 'preview', revision: 1, status: 'ready', selected: ['frontend', 'basecoat'],
  probabilities: { frontend: 0.96, basecoat: 0.89, 'better-writing': 0.31 }, threshold: 0.75, elapsedMs: 120,
}

export const commands: ComposerCommand[] = [
  { name: 'compact', description: 'Compact older conversation history', source: 'harness' },
  { name: 'goal', description: 'Create, pause, resume, or complete the session goal', hint: '[action]', source: 'harness' },
  { name: 'plan', description: 'Enter or leave plan mode', hint: '[off|message]', source: 'harness' },
  { name: 'permissions', description: 'Change the permission preset', source: 'harness' },
  { name: 'review-diff', description: 'Review the current diff against the base branch', hint: '[focus]', source: 'workspace' },
  { name: 'release-notes', description: 'Draft release notes from the commits since the last tag', source: 'workspace' },
]
export const commandCatalog: CommandCatalog = { commands, available: true }
export const commandCatalogUnavailable: CommandCatalog = { commands: [], available: false }

export const chatMessages: ChatMessage[] = [
  { id: 1, role: 'user', label: 'You', text: 'Round the option buttons to match the answer box.',
    context: { fileLabel: 'src/webview/App.svelte', languageId: 'svelte', ranges: [{ startLine: 33, startColumn: 11, endLine: 33, endColumn: 74 }] },
    browserLabels: ['Save button'] },
  { id: 2, role: 'reasoning', label: 'Thinking', text: 'The option buttons carry the basecoat radius; the answer box is rounded-[8px].' },
  { id: 3, role: 'assistant', label: 'Helix', text: 'Added `rounded-[8px]` to the option buttons.\n\n```svelte\n<button class="btn rounded-[8px]">\n```\n\nBoth corners now measure 8px.' },
  { id: 4, role: 'tool', label: 'Tool', text: '', tool },
  { id: 5, role: 'activity', label: 'Subagent', text: 'Finished child session' },
  { id: 6, role: 'compaction', label: 'Context', text: '', compaction: { key: 'preview-summary', sessionId: 'preview', kind: 'summary', status: 'completed', historyItems: 12, shadowedTokens: 4200 } },
  { id: 7, role: 'changes', label: 'Changes', text: '', changes, panelOpen: true },
]

export const questionMessage: ChatMessage = {
  id: 8, role: 'tool', label: 'Tool', text: '',
  tool: { callId: question.toolCallId, name: 'ask_user_question', arguments: '', status: 'running', question },
}

/** A command the user ran: a normal turn whose `/name` token is gold. */
export const planCommandMessage: ChatMessage = {
  id: 9, role: 'user', label: 'You',
  text: commandLine('plan', 'map the transcript render path, then keep it under 40 lines'),
  html: commandLineHtml('plan', 'map the transcript render path, then keep it under 40 lines'),
}

/** The rule that marks where plan mode was entered, and where it was left. */
export const planRuleMessage: ChatMessage = { id: 10, role: 'divider', label: 'Plan Mode', text: 'Plan Mode' }
export const planRuleOffMessage: ChatMessage = { id: 11, role: 'divider', label: 'Plan Mode', text: 'Plan Mode Off' }

export const hostSettings: SidebarSettings = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  contextWindow: 128000,
  baseUrl: 'https://api.deepseek.com',
  dshHome: '/tmp/dsh',
  apiKeyConfigured: true,
  skillPickerEnabled: false,
  sandboxMode: 'workspace-write',
  mcpServers: [],
}

/**
 * The messages the extension host sends across one streamed turn. Feeding the
 * list to App runs the whole router: session, settings, model, tokens, tools.
 */
export const hostTurn: IncomingMessage[] = [
  { type: 'state', state: { activeSessionId: 'session-1', runtimeState: 'ready', reasoningEffort: 'high' } },
  { type: 'settings', settings: hostSettings },
  { type: 'modelCatalog', models, reasoningHistory: {} },
  { type: 'accepted', sessionId: 'session-1', modelId: 'deepseek-v4-flash', reasoningEffort: 'high' },
  { type: 'assistantStream', sessionId: 'session-1', agentSessionId: 'session-1', frame: { type: 'start' } },
  { type: 'assistantStream', sessionId: 'session-1', agentSessionId: 'session-1',
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Reading the composer, then the model wiring.' } } },
  { type: 'notification', sessionId: 'session-1', notification: {
    method: 'session.event',
    params: { sessionId: 'session-1', event: { type: 'tool/call',
      data: { name: 'read_file', callId: 'tool-1', arguments: '{"path":"src/webview/App.svelte"}' } } },
  } },
  { type: 'notification', sessionId: 'session-1', notification: {
    method: 'session.event',
    params: { sessionId: 'session-1', event: { type: 'tool/result',
      data: { callId: 'tool-1', message: { content: 'export default App' } } } },
  } },
  { type: 'codeChanges', sessionId: 'session-1', changes: [changes[1]!], active: true },
  { type: 'notification', sessionId: 'session-1', notification: {
    method: 'session.status', params: { sessionId: 'session-1', status: 'idle' } },
  },
]
