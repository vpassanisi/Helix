import type { ChatMessage, CodeChange, IncomingMessage, ModelEditorDraft, SidebarDiscoveredModel, SidebarModel, McpServerDraft, RequestPreviewResult, SidebarSettings, ToolCallView } from '../src/webview/types.js'
import type { BrowserElementContext } from '../src/shared/browser-context.js'
import type { UserQuestionView } from '../src/shared/user-question.js'
import type { SkillSummary, SkillSuggestions } from '../src/shared/skills.js'
import type { GenUiView } from '../src/shared/gen-ui.js'
import { commandLine, commandLineHtml, type CommandCatalog, type ComposerCommand } from '../src/shared/commands.js'

export const changes: CodeChange[] = [
  { path: 'src/webview/components/ChangesPanel.svelte', kind: 'created', additions: 92, deletions: 0 },
  { path: 'src/webview/App.svelte', kind: 'modified', additions: 3, deletions: 62 },
  { path: 'src/webview/theme.css', oldPath: 'src/webview/colors.css', kind: 'renamed', additions: 0, deletions: 0 },
  { path: 'src/webview/legacy.css', kind: 'deleted', additions: 0, deletions: 24 },
]

export const models: SidebarModel[] = [
  { id: 'deepseek-v4-flash', displayName: 'DeepSeek Flash', contextWindow: 128000, acceptsImages: false, reasoningFormat: 'openai', reasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'local-coder', displayName: 'Local Coder', contextWindow: 32000, acceptsImages: true, reasoningFormat: 'qwen', binaryThinkingMode: 'on', reasoningEfforts: [],
    systemInstructions: 'This model over-reads files. Search with grep and read a line range, not a whole file.' },
]
export const discoveredModels: SidebarDiscoveredModel[] = [...models, { id: 'new-coder', displayName: 'New Coder', contextWindow: 64000 }]
export const modelDrafts: ModelEditorDraft[] = models.map((model, index) => ({
  ...model, key: index + 1, sourceId: model.id, reasoningEfforts: model.reasoningEfforts ?? [],
  chatTemplateKwargsText: '{}', chatTemplateArgsText: '{}', systemInstructions: model.systemInstructions ?? '',
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

/** Cards as a `show_ui` call leaves them: a title, a spec, a status. */
export const genUiTestSuite: GenUiView = {
  callId: 'ui-suite',
  title: 'Test suite',
  status: 'rendered',
  spec: {
    root: 'card',
    state: { suite: { passing: 18, failing: 3, seconds: 41 } },
    elements: {
      card: { type: 'Card', props: { title: 'Ship readiness', subtitle: 'main, 2 minutes ago' }, children: ['grid', 'bar', 'note', 'actions'] },
      grid: { type: 'Grid', props: { columns: 2 }, children: ['passing', 'failing'] },
      passing: { type: 'Metric', props: { label: 'Passing', value: '18', tone: 'success' } },
      failing: { type: 'Metric', props: { label: 'Failing', value: '3', tone: 'danger', delta: 'webdav, search, otel' } },
      bar: { type: 'Progress', props: { label: 'Suites reported', value: 4, max: 6 } },
      note: { type: 'Text', props: { text: 'Two of the three failures are the new timeout in the search suite.', tone: 'muted' } },
      actions: { type: 'Stack', props: { direction: 'horizontal' }, children: ['rerun', 'badge'] },
      rerun: { type: 'Button', props: { label: 'Re-run the 3 failing tests', variant: 'primary' }, on: { press: { action: 'prompt', params: { text: 'Re-run the three failing tests and show the output.' } } } },
      badge: { type: 'Badge', props: { label: '41s', tone: 'neutral' } },
    },
  },
}

/**
 * A long session for the composer story: enough turns, tools, cards and
 * compaction that the transcript scrolls above the composer. Ids start at
 * 100 so they never collide with the single-message fixtures above.
 */
export const historyMessages: ChatMessage[] = [
  { id: 100, role: 'user', label: 'You', text: 'The model picker drops below the bottom edge of the sidebar on short windows. Can you make it flip up instead?' },
  { id: 101, role: 'reasoning', label: 'Thinking', text: 'The picker is anchored with `top-full mt-1`, so it can only open downward. I need to measure the free space below the trigger on open and flip the anchor to `bottom-full mb-1` when there is less room than the menu needs.' },
  { id: 102, role: 'assistant', label: 'Helix', text: 'Reproduced it. The menu is absolutely positioned below the trigger, so on a 400px-tall sidebar it clips:\n\n```svelte\n<div class="absolute top-full mt-1 w-56">\n```' },
  { id: 103, role: 'tool', label: 'Tool', text: '', tool: { ...tool, callId: 'history-read', name: 'read_file', arguments: '{"path":"src/webview/components/ComposerModelPicker.svelte"}', result: 'The trigger is a button in the composer footer; the menu mounts under it on open.' } },
  { id: 104, role: 'assistant', label: 'Helix', text: 'Two changes in `ComposerModelPicker.svelte`:\n\n1. Measure the free space below the trigger when the menu opens.\n2. Flip the anchor class when that space is shorter than the menu.\n\n```svelte\n{#if open && flipUp}\n  <div class="absolute bottom-full mb-1 w-56">\n    {#each models as model}\n      <button class="w-full text-left" onclick={() => select(model.id)}>\n        {model.displayName}\n      </button>\n    {/each}\n  </div>\n{/if}' },
  { id: 105, role: 'user', label: 'You', text: 'Nice. While you are in there — the model list footer only shows the reasoning effort. Add the context window next to it.' },
  { id: 106, role: 'reasoning', label: 'Thinking', text: 'The footer already renders per-model metadata; the context window is on the model entry, so I just format it as `128k` and join it with the effort.' },
  { id: 107, role: 'assistant', label: 'Helix', text: 'Done. The footer now reads `128k context · High`:\n\n```svelte\n<span class="text-xs opacity-60">{formatContext(model.contextWindow)} context{effortLabel(model)}</span>' },
  { id: 108, role: 'ui', label: 'Card', text: '', ui: genUiTestSuite },
  { id: 109, role: 'activity', label: 'Subagent', text: 'Verified the flip in the 360×520 canvas: menu opens upward, no clipping' },
  { id: 110, role: 'compaction', label: 'Context', text: '', compaction: { key: 'history-summary', sessionId: 'preview', kind: 'summary', status: 'completed', historyItems: 24, shadowedTokens: 9400 } },
  { id: 111, role: 'changes', label: 'Changes', text: '', changes, panelOpen: true },
  { id: 112, role: 'assistant', label: 'Helix', text: 'All green. The picker flips up on short windows, the footer shows the context window, and the picker tests pass. Two files touched, 38 lines added.' },
]

export const genUiAlerts: GenUiView = {
  callId: 'ui-alerts',
  title: 'Deploy check',
  status: 'rendered',
  spec: {
    root: 'card',
    elements: {
      card: { type: 'Stack', props: {}, children: ['head', 'danger', 'warn', 'table', 'sep', 'list'] },
      head: { type: 'Heading', props: { text: 'Blocked on two things', level: 'h2' } },
      danger: { type: 'Alert', props: { tone: 'danger', title: 'Migration is not applied', text: 'release_042 is pending on staging. Deploying now drops the old column.' } },
      warn: { type: 'Alert', props: { tone: 'warning', text: 'The otel plugin test suite is not running in CI.' } },
      table: { type: 'Table', props: { caption: 'Environments', columns: ['Env', 'Build', 'Age'], rows: [['staging', 'a91f2c', '2h'], ['prod', '7d0e11', '3d']] } },
      sep: { type: 'Separator', props: { spacing: 'md' } },
      list: { type: 'List', props: { ordered: true }, children: ['first', 'second'] },
      first: { type: 'ListItem', props: { text: 'Apply the migration', note: 'ops.run("migrate --release 042")' } },
      second: { type: 'ListItem', props: { text: 'Re-run the deploy', tone: 'muted' } },
    },
  },
}

export const genUiReleaseNoteForm: GenUiView = {
  callId: 'ui-form',
  title: 'Release note',
  status: 'rendered',
  spec: {
    root: 'card',
    state: { form: { note: '', ship: true } },
    elements: {
      card: { type: 'Card', props: { title: 'Write the release note' }, children: ['note', 'ship', 'preview', 'send'] },
      note: { type: 'TextInput', props: { label: 'What ships?', placeholder: 'One sentence for the changelog', value: { $bindState: '/form/note' } } },
      ship: { type: 'Checkbox', props: { label: 'Publish after the release note is written', checked: { $bindState: '/form/ship' } } },
      preview: { type: 'Text', props: { text: { $template: 'Preview: ${/form/note}' }, tone: 'muted' } },
      send: { type: 'Button', props: { label: 'Send to Helix', variant: 'primary' }, on: { press: { action: 'prompt', params: { text: { $template: 'Write the release note from this: ${/form/note}' } } } } },
    },
  },
}

/**
 * Code inside a card. The JSON a CodeBlock carries is a plain string prop, so
 * the card can hand over the very text a button then copies.
 */
const mcpConfigJson = `{
  "mcpServers": {
    "docs": {
      "transport": "streamable-http",
      "url": "http://localhost:3000/mcp",
      "env": { "DOCS_TOKEN": "" }
    }
  }
}`

export const genUiCodeSnippet: GenUiView = {
  callId: 'ui-code',
  title: 'MCP config',
  status: 'rendered',
  spec: {
    root: 'card',
    elements: {
      card: { type: 'Card', props: { title: 'Add the docs server', subtitle: 'Helix settings, MCP tab' }, children: ['intro', 'json', 'command', 'actions'] },
      intro: { type: 'Text', props: { text: 'Paste this block, then start the server.', tone: 'muted' } },
      json: { type: 'CodeBlock', props: { language: 'json', code: mcpConfigJson } },
      command: { type: 'CodeBlock', props: { language: 'bash', code: 'npx -y @acme/mcp-docs --port 3000' } },
      actions: { type: 'Stack', props: { direction: 'horizontal' }, children: ['copy', 'apply'] },
      copy: { type: 'Button', props: { label: 'Copy the JSON', variant: 'primary' }, on: { press: { action: 'copy', params: { text: mcpConfigJson } } } },
      apply: { type: 'Button', props: { label: 'Add it for me' }, on: { press: { action: 'prompt', params: { text: 'Add the docs MCP server to my Helix settings.' } } } },
    },
  },
}

const retrySnippet = `const reply = await withRetry(() => harness.send(prompt), {
  attempts: 3,
  backoff: 'exponential',
})`

/** The code example: a snippet to read, the diff that applies it, a patch to copy. */
export const genUiCodeExample: GenUiView = {
  callId: 'ui-code-example',
  title: 'Retry helper',
  status: 'rendered',
  spec: {
    root: 'card',
    elements: {
      card: { type: 'Card', props: { title: 'Use the retry helper', subtitle: 'src/runtime/retry.ts' }, children: ['head', 'snippet', 'sep', 'diff', 'note', 'actions'] },
      head: { type: 'Heading', props: { text: 'Call it like this', level: 'h3' } },
      snippet: { type: 'CodeBlock', props: { language: 'typescript', code: retrySnippet } },
      sep: { type: 'Separator', props: { spacing: 'sm' } },
      diff: { type: 'CodeBlock', props: { language: 'diff', code: `- await harness.send(prompt)\n+ await withRetry(() => harness.send(prompt), {\n+   attempts: 3,\n+ })` } },
      note: { type: 'Text', props: { text: 'The helper is in runtime already. Long lines scroll sideways.' } },
      actions: { type: 'Stack', props: { direction: 'horizontal' }, children: ['copy', 'patch'] },
      copy: { type: 'Button', props: { label: 'Copy the snippet', variant: 'primary' }, on: { press: { action: 'copy', params: { text: retrySnippet } } } },
      patch: { type: 'Button', props: { label: 'Apply the patch' }, on: { press: { action: 'prompt', params: { text: 'Apply this patch and run the runtime tests.' } } } },
    },
  },
}

const capturedRequestJson = `{
  "model": "deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "Why is the composer slow?" }],
  "reasoning_effort": "high",
  "tools": [{ "type": "function", "function": { "name": "show_ui", "description": "Render a card", "parameters": { "type": "object", "properties": { "spec": { "type": "object" } }, "required": ["spec"] } } }]
}`

/** The JSON the agent quotes back: a captured request body, keys read at a glance. */
export const genUiJsonPayload: GenUiView = {
  callId: 'ui-payload',
  title: 'Captured request',
  status: 'rendered',
  spec: {
    root: 'card',
    elements: {
      card: { type: 'Card', props: { title: 'Provider request body', subtitle: 'session-1, 18 keys' }, children: ['keys', 'json', 'actions'] },
      keys: { type: 'Table', props: { caption: 'Top-level keys', columns: ['Key', 'Value'], rows: [['model', 'deepseek-v4-flash'], ['reasoning_effort', 'high'], ['tools', '17']] } },
      json: { type: 'CodeBlock', props: { language: 'json', code: capturedRequestJson } },
      actions: { type: 'Stack', props: { direction: 'horizontal' }, children: ['copy', 'badge'] },
      copy: { type: 'Button', props: { label: 'Copy the body', variant: 'primary' }, on: { press: { action: 'copy', params: { text: capturedRequestJson } } } },
      badge: { type: 'Badge', props: { label: 'truncated', tone: 'warning' } },
    },
  },
}

/**
 * A card a real `show_ui` call produced. Kept verbatim: seven of these fourteen
 * code lines are wider than the sidebar, and the card has an accent tone, so
 * this is the shape that reads as a highlighted band rather than code.
 */
const webhookSchemaJs = `// tenant DB (Echo), collection: webhooks
{
  _id: "config",          // singleton per tenant
  version: 7,             // CAS -> 409 on conflict
  webhooks: [
    { id: "01J...",        // stable, referenced by deliveries
      name: "pagerduty-p1",
      enabled: true,
      target: "incident",   // alert | incident
      match: { names: [], labels: { severity: ["critical"] } },
      url, secret, template, timeoutMs, retries,
      createdAt, lastUpdated }
  ]
}`

export const genUiWebhookDesign: GenUiView = {
  callId: 'ui-webhooks',
  title: 'Webhook config design',
  status: 'rendered',
  spec: {
    root: 'card',
    elements: {
      card: { type: 'Card', props: { title: 'Webhook config design', subtitle: 'Recommended: singleton doc, ordered array, RPC hides the embedding', tone: 'accent' }, children: ['doc', 'split', 'layout', 'next'] },
      doc: { type: 'CodeBlock', props: { language: 'js', code: webhookSchemaJs } },
      split: { type: 'Separator', props: { spacing: 'md' } },
      layout: { type: 'Table', props: { caption: 'who reads and writes what', columns: ['Piece', 'Lives in', 'Notes'], rows: [
        ['Config doc', 'tenant DB on Echo', 'singleton, ordered array'],
        ['Dipper', 'reader', 'hot path, cache keyed on version'],
        ['webhook-deliveries', 'tenant DB', 'TTL, index webhookId+createdAt'],
        ['CRUD RPCs', 'Sky rpc/webhooks', 'tenantDatabase interceptor'],
        ['Matching', 'Tamarack rules Match', 'reuse the label model'],
        ['Not on Stagecoach', 'standalone mongo', 'no transactions available'],
      ] } },
      next: { type: 'Alert', props: { tone: 'warning', title: 'Decide before schema', text: 'Per-item match plus dedupe per batch, or one dispatch per batch?' } },
    },
  },
}

export const genUiFailed: GenUiView = {
  callId: 'ui-failed',
  title: 'Quarterly report',
  status: 'failed',
  spec: { root: '', elements: {} },
  error: 'spec does not match the Helix catalog: chart: "Marquee" is not a Helix component. Use one of Stack, Grid, Card, Heading, Text.',
}

export const genUiDismissed: GenUiView = { ...genUiTestSuite, callId: 'ui-dismissed', status: 'dismissed' }

/** The card, in the transcript among the other rows. */
export const uiCardMessage: ChatMessage = { id: 9, role: 'ui', label: 'Card', text: '', ui: genUiTestSuite }

/**
 * A turn that ends with a card. The spec rides in the tool call's arguments,
 * exactly as the runtime hands it over, and the result is a one-line summary —
 * the card is the content, not the tool row.
 */
export const hostCardTurn: IncomingMessage[] = [
  { type: 'state', state: { activeSessionId: 'session-1', runtimeState: 'ready', reasoningEffort: 'high' } },
  { type: 'settings', settings: hostSettings },
  { type: 'modelCatalog', models, reasoningHistory: {} },
  { type: 'accepted', sessionId: 'session-1', modelId: 'deepseek-v4-flash', reasoningEffort: 'high' },
  { type: 'assistantStream', sessionId: 'session-1', agentSessionId: 'session-1', frame: { type: 'start' } },
  { type: 'assistantStream', sessionId: 'session-1', agentSessionId: 'session-1',
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Here is where the suite stands.' } } },
  { type: 'notification', sessionId: 'session-1', notification: {
    method: 'session.event',
    params: { sessionId: 'session-1', event: { type: 'tool/call',
      data: { name: 'show_ui', callId: 'ui-suite', arguments: JSON.stringify({ title: 'Test suite', spec: genUiTestSuite.spec }) } } },
  } },
  { type: 'notification', sessionId: 'session-1', notification: {
    method: 'session.event',
    params: { sessionId: 'session-1', event: { type: 'tool/result',
      data: { callId: 'ui-suite', message: { content: 'Shown to the user as a card (9 elements).' } } } },
  } },
  { type: 'notification', sessionId: 'session-1', notification: {
    method: 'session.status', params: { sessionId: 'session-1', status: 'idle' } },
  },
]
