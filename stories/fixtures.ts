import type { CodeChange, ModelEditorDraft, SidebarDiscoveredModel, SidebarModel, McpServerDraft, RequestPreviewResult, ToolCallView } from '../src/webview/types.js'
import type { BrowserElementContext } from '../src/shared/browser-context.js'
import type { UserQuestionView } from '../src/shared/user-question.js'
import type { SkillSummary, SkillSuggestions } from '../src/shared/skills.js'

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
export function modelOptionLabel(model: SidebarModel): string {
  return `${model.displayName ?? model.id}${model.contextWindow === undefined ? '' : ` · ${new Intl.NumberFormat().format(model.contextWindow)}`}`
}

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

export const skills: SkillSummary[] = [
  { name: 'frontend', description: 'Build and refine frontend interfaces.', modelInvocable: true, userInvocable: true },
  { name: 'basecoat', description: 'Use the existing Basecoat components.', modelInvocable: true, userInvocable: true },
  { name: 'better-writing', description: 'Write clear, concise prose.', modelInvocable: true, userInvocable: true },
]
export const suggestions: SkillSuggestions = {
  sessionId: 'preview', revision: 1, status: 'ready', selected: ['frontend', 'basecoat'],
  probabilities: { frontend: 0.96, basecoat: 0.89, 'better-writing': 0.31 }, threshold: 0.75, elapsedMs: 120,
}
