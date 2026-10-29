import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRuntimePatchLines,
  createClientOptions,
  createRuntimeEnvironment,
  piAiModelProfilePatchLines,
  yamlString,
  type ContextPatch,
} from '../runtime/runtime-context-patch.js'
import type { ControlBroker } from '../runtime/control-bridge.js'
import type { RuntimeOptions } from '../runtime/types.js'

function options(overrides: Partial<RuntimeOptions> = {}): RuntimeOptions {
  return {
    cwd: '/workspace/project',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sandboxMode: 'workspace-write',
    mcpServers: [],
    ...overrides,
  }
}

const fakeBroker = { endpoint: '/tmp/helix-control.sock', token: 'test-token' } as unknown as ControlBroker

test('deepseek-official with a context window patches the built-in catalog', () => {
  const lines = buildRuntimePatchLines(options({ contextWindow: 131072 }))
  const text = lines.join('\n')
  assert.match(text, /- id: llm-deepseek/)
  assert.match(text, /defaultContextWindow: 131072/)
  assert.match(text, /- id: "deepseek-flash"/)
  assert.match(text, /contextWindow: 131072/)
})

test('deepseek-official saved models override catalog entries', () => {
  const lines = buildRuntimePatchLines(options({
    savedModels: [{ id: 'deepseek-flash', displayName: 'Flash (local)', contextWindow: 32768, acceptsImages: true }],
  }))
  const text = lines.join('\n')
  assert.match(text, /name: "Flash \(local\)"/)
  assert.match(text, /contextWindow: 32768/)
  assert.match(text, /inputModalities: \["text", "image"\]/)
})

test('a custom provider declares the pi-ai route from the settings', () => {
  const lines = buildRuntimePatchLines(options({
    provider: 'llama',
    model: 'gpt-oss-20b',
    baseUrl: 'http://127.0.0.1:8080/v1',
    contextWindow: 131072,
  }))
  const text = lines.join('\n')
  assert.match(text, /- id: llm-pi-ai/)
  assert.match(text, /"llama":/)
  assert.match(text, /api: openai-completions/)
  assert.match(text, /apiKeyEnv: DEEPSEEK_API_KEY/)
  assert.match(text, /baseURL: !!js process\.env\.DEEPSEEK_BASE_URL/)
  assert.match(text, /defaultContextWindow: 131072/)
  assert.match(text, /- id: "gpt-oss-20b"/)
  assert.match(text, /input: \["text"\]/)
})

test('a custom provider with saved models lists their runtime profiles', () => {
  const lines = buildRuntimePatchLines(options({
    provider: 'llama',
    model: 'gpt-oss-20b',
    savedModels: [
      { id: 'gpt-oss-20b', displayName: 'Local 20B', contextWindow: 131072, reasoningFormat: 'qwen' },
      { id: 'qwen3-8b', acceptsImages: true },
    ],
  }))
  const text = lines.join('\n')
  assert.match(text, /- id: "gpt-oss-20b"/)
  assert.match(text, /name: "Local 20B"/)
  assert.match(text, /contextWindow: 131072/)
  assert.match(text, /thinkingFormat: "qwen"/)
  assert.match(text, /supportsReasoningEffort: false/)
  assert.match(text, /- id: "qwen3-8b"/)
  assert.match(text, /input: \["text", "image"\]/)
})

test('the patch always mounts the Helix control plugins and sandbox policy', () => {
  const text = buildRuntimePatchLines(options()).join('\n')
  assert.match(text, /- id: helix-control-bridge/)
  assert.match(text, /cwd: "\/workspace\/project"/)
  assert.match(text, /- id: helix-question-tool/)
  assert.match(text, /- id: helix-report-progress-tool/)
  assert.match(text, /- id: helix-gen-ui-tool/)
  assert.match(text, /- id: sandbox-policy/)
  assert.match(text, /workspaceRoot: "\/workspace\/project"/)
})

test('disabled tool bundles arrive as plugin config switches, not disable rows', () => {
  const enabledLines = buildRuntimePatchLines(options())
  const enabledReport = enabledLines.findIndex((line) => line.includes('helix-report-progress-tool'))
  assert.match(enabledLines[enabledReport + 3], /enabled: true/, 'tool bundles are enabled by default')

  const lines = buildRuntimePatchLines(options({ disabledToolBundles: ['helix-gen-ui', 'helix-report-progress'] }))
  const reportIdx = lines.findIndex((line) => line.includes('helix-report-progress-tool'))
  const genUiIdx = lines.findIndex((line) => line.includes('helix-gen-ui-tool'))
  assert.match(lines[reportIdx + 3], /enabled: false/, 'a disabled bundle flips its config switch')
  assert.match(lines[genUiIdx + 3], /enabled: false/)
  assert.equal(lines.includes('- id: "helix-gen-ui"'), false, 'config-toggled bundles are not listed in the disable section')
  assert.equal(lines.includes('- id: "helix-report-progress"'), false)

  const bashOff = buildRuntimePatchLines(options({ disabledToolBundles: ['tool-bash'] }))
  const bashIdx = bashOff.findIndex((line) => line === '- id: "tool-bash"')
  assert.ok(bashIdx >= 0, 'a non-toggled bundle is listed in the disable section')
  assert.equal(bashOff[bashIdx + 1], '  disabled: true')
})

test('an isolated session store root is patched for short-lived runtimes', () => {
  const text = buildRuntimePatchLines(options({ sessionStorageRoot: '/tmp/sessions-1' })).join('\n')
  assert.match(text, /- id: sessions/)
  assert.match(text, /root: "\/tmp\/sessions-1"/)
})

test('user plugins and MCP servers are appended to the patch', () => {
  const text = buildRuntimePatchLines(options({
    plugins: [{ id: 'my-plugin', modulePath: '/abs/bundle.mjs', config: { a: 1 } }],
    mcpServers: [{
      serverName: 'files',
      transport: 'stdio',
      command: '/usr/bin/mcp-files',
      args: [],
      env: { API_KEY: 'secret' },
    }],
  })).join('\n')
  assert.match(text, /- id: "my-plugin"/)
  assert.match(text, /- id: "mcp-files"/)
  assert.match(text, /API_KEY: !!js process\.env\.DSH_MCP_FILES_API_KEY_[A-F0-9]{12}/)
})

test('createRuntimeEnvironment exports the control channel and credentials', () => {
  const env = createRuntimeEnvironment(options({
    dshHome: '/tmp/dsh-home',
    apiKey: 'sk-test',
    baseUrl: 'http://127.0.0.1:8080/v1',
    provider: 'llama',
    mcpServers: [{ serverName: 'files', transport: 'stdio', command: '/usr/bin/mcp-files', args: [], env: { API_KEY: 'secret' } }],
  }), fakeBroker)
  assert.equal(env.HELIX_CONTROL_ENDPOINT, '/tmp/helix-control.sock')
  assert.equal(env.HELIX_CONTROL_TOKEN, 'test-token')
  assert.equal(env.DSH_PERMISSION_MODE, 'workspace-write')
  assert.equal(env.DSH_HOME, '/tmp/dsh-home')
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-test')
  assert.equal(env.DEEPSEEK_BASE_URL, 'http://127.0.0.1:8080/v1', 'a custom route keeps its own base URL')
  const mcpKey = Object.keys(env).find((key) => /^DSH_MCP_FILES_API_KEY_[A-F0-9]{12}$/.test(key))
  assert.ok(mcpKey, 'the MCP secret env var is derived from server and key name')
  assert.equal(env[mcpKey!], 'secret')
})

test('the DeepSeek official root is rewritten to the Messages endpoint', () => {
  const env = createRuntimeEnvironment(options({ baseUrl: 'https://api.deepseek.com' }), fakeBroker)
  assert.equal(env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com/anthropic')

  const versioned = createRuntimeEnvironment(options({ baseUrl: 'https://api.deepseek.com/v1' }), fakeBroker)
  assert.equal(versioned.DEEPSEEK_BASE_URL, 'https://api.deepseek.com/anthropic')

  const other = createRuntimeEnvironment(options({ baseUrl: 'https://api.deepseek.com/v2' }), fakeBroker)
  assert.equal(other.DEEPSEEK_BASE_URL, 'https://api.deepseek.com/v2', 'an unexpected path is left alone')
})

test('createClientOptions carries the patch path and the environment', () => {
  const patched = createClientOptions(options({ dshBin: '/usr/bin/dsh' }), fakeBroker, { path: '/tmp/patch.yml', directory: '/tmp' } as ContextPatch)
  assert.equal(patched.dshBin, '/usr/bin/dsh')
  assert.equal(patched.profile, 'sdk')
  assert.deepEqual(patched.patches, ['/tmp/patch.yml'])
  assert.equal(patched.processCwd, '/workspace/project')
  assert.equal(patched.env?.HELIX_CONTROL_ENDPOINT, '/tmp/helix-control.sock')

  const bare = createClientOptions(options(), fakeBroker, undefined)
  assert.equal(bare.patches, undefined)
})

test('piAiModelProfilePatchLines renders profile fields', () => {
  const lines = piAiModelProfilePatchLines([
    { id: 'a', name: 'A', contextWindow: 1024, input: ['text'], reasoningEfforts: { low: 'low', off: null } },
    { id: 'b', input: ['text', 'image'], reasoningEfforts: false, compat: { thinkingFormat: 'qwen', supportsReasoningEffort: false } },
  ])
  assert.deepEqual(lines, [
    '          - id: "a"',
    '            name: "A"',
    '            contextWindow: 1024',
    '            input: ["text"]',
    '            reasoningEfforts:',
    '              "low": "low"',
    '              "off": null',
    '          - id: "b"',
    '            input: ["text", "image"]',
    '            reasoningEfforts: false',
    '            compat:',
    '              thinkingFormat: "qwen"',
    '              supportsReasoningEffort: false',
  ])
})

test('yamlString double-quotes like JSON', () => {
  assert.equal(yamlString('plain'), '"plain"')
  assert.equal(yamlString('has "quotes"'), '"has \\"quotes\\""')
  assert.equal(yamlString('back\\slash'), '"back\\\\slash"')
})
