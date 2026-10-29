import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { mcpSecretKey } from '../runtime/mcp.js'
import type { SidebarOutgoingMessage } from '../sidebar/sidebar-protocol.js'
import type { SettingsControllerOptions } from '../host/settings-controller.js'

// Isolated VS Code API fixture: configuration reads come from a values Map and
// workspace.fs is backed by a real temp directory for the models catalog.
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === 'vscode' ? { url: 'mock:vscode', shortCircuit: true } : next(specifier, context) },
  load(url, context, next) {
    if (url !== 'mock:vscode') return next(url, context)
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        import { mkdir, readFile, writeFile } from 'node:fs/promises';
        export const values = new Map();
        export const ConfigurationTarget = { Global: 1 };
        export const Uri = { joinPath: (uri, name) => ({ fsPath: uri.fsPath + '/' + name }) };
        export const env = { appRoot: '/tmp' };
        export const window = { showWarningMessage() {}, showErrorMessage() {}, showInformationMessage() {} };
        export const workspace = {
          workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
          fs: {
            readFile: async (uri) => {
              try { return new Uint8Array(await readFile(uri.fsPath)) }
              catch (error) {
                if (error?.code === 'ENOENT') {
                  const notFound = new Error('File not found: ' + uri.fsPath);
                  notFound.code = 'FileNotFound';
                  throw notFound;
                }
                throw error;
              }
            },
            writeFile: async (uri, content) => { await writeFile(uri.fsPath, Buffer.from(content)) },
            createDirectory: async (uri) => { await mkdir(uri.fsPath, { recursive: true }) },
          },
          getConfiguration: (prefix) => ({
            get: (key, fallback) => values.get(prefix ? prefix + '.' + key : key) ?? fallback,
            update: async (key, value) => { values.set(key, value) },
          }),
        };
      `,
    }
  },
})
const { SettingsController } = await import('../host/settings-controller.js')
const vscode = await import('vscode') as unknown as { values: Map<string, unknown> }

interface ControllerHarness {
  storage: string
  state: Map<string, unknown>
  secrets: Map<string, string>
  posts: SidebarOutgoingMessage[]
  restarts: unknown[]
  starts: number[]
  sandboxCalls: Array<[string, string]>
  errors: unknown[]
  runtimeState: string
  controller: InstanceType<typeof SettingsController>
}

async function createHarness(runtimeState = 'stopped'): Promise<ControllerHarness> {
  const storage = join(tmpdir(), `helix-settings-controller-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(storage, { recursive: true })
  const state = new Map<string, unknown>()
  const secrets = new Map<string, string>()
  const posts: SidebarOutgoingMessage[] = []
  const restarts: unknown[] = []
  const starts: number[] = []
  const sandboxCalls: Array<[string, string]> = []
  const errors: unknown[] = []
  const controller = new SettingsController({
    context: {
      extensionPath: '/extension',
      globalStorageUri: { fsPath: storage },
      globalState: { get: (key: string, fallback?: unknown) => (state.has(key) ? state.get(key) : fallback), update: async (key: string, value: unknown) => { state.set(key, value); return true } },
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value) },
        delete: async (key: string) => { secrets.delete(key) },
      },
    },
    runtime: {
      start: async () => { starts.push(1) },
      restart: async (options: unknown) => { restarts.push(options) },
      setSandboxMode: async (sessionId: string, mode: string) => { sandboxCalls.push([sessionId, mode]) },
    },
    sidebar: { post: (message: SidebarOutgoingMessage) => { posts.push(message) } },
    getRuntimeState: () => runtimeState,
    getActiveSessionId: () => 'session-1',
    onError: (error: unknown) => { errors.push(error) },
  } as unknown as SettingsControllerOptions)

  return { storage, state, secrets, posts, restarts, starts, sandboxCalls, errors, runtimeState, controller }
}

async function discard(harness: ControllerHarness): Promise<void> {
  await rm(harness.storage, { recursive: true, force: true })
}

test('saveMcpServers persists the normalized list, stores secrets, and restarts', async () => {
  const harness = await createHarness()
  try {
    await harness.controller.saveMcpServers({
      type: 'saveMcpServers',
      mcpServers: [{ serverName: 'files', transport: 'stdio', command: '/usr/bin/mcp-files', args: ['--root', ''], url: '', env: [{ name: 'API_KEY', value: 'tok' }] }],
    })

    assert.deepEqual(harness.errors, [])
    const saved = vscode.values.get('deepseekHarness.mcpServers') as Array<Record<string, unknown>>
    assert.deepEqual(saved, [
      { serverName: 'files', transport: 'stdio', command: '/usr/bin/mcp-files', args: ['--root'], url: undefined, envKeys: ['API_KEY'] },
    ])
    assert.equal(harness.secrets.get(mcpSecretKey('files', 'API_KEY')), 'tok')
    assert.equal(harness.starts.length + harness.restarts.length, 1, 'a stopped runtime is started with the new servers')
    const savedMessage = harness.posts.find((message) => message.type === 'settingsSaved')
    assert.equal(savedMessage?.type, 'settingsSaved')
    assert.equal((savedMessage as { restarting?: boolean }).restarting, true)

    await harness.controller.saveMcpServers({
      type: 'saveMcpServers',
      mcpServers: [
        { serverName: 'files', transport: 'stdio', command: '/usr/bin/mcp-files', args: [], url: '', env: [] },
        { serverName: 'files', transport: 'stdio', command: '/usr/bin/other', args: [], url: '', env: [] },
      ],
    })
    assert.equal(harness.errors.length, 1, 'a duplicate server name is rejected')
    assert.equal(harness.starts.length + harness.restarts.length, 1, 'the rejected save does not touch the runtime')
  } finally {
    await discard(harness)
  }
})

test('saveTools normalizes the bundle list and posts without a restart', async () => {
  const harness = await createHarness()
  try {
    await harness.controller.saveTools({ type: 'saveTools', disabledToolBundles: ['tool-bash', 'not-a-bundle', 'tool-subagent'] })

    assert.deepEqual(harness.errors, [])
    assert.deepEqual(vscode.values.get('deepseekHarness.disabledToolBundles'), ['tool-bash', 'tool-subagent'])
    assert.equal(harness.restarts.length, 0)
    assert.equal(harness.starts.length, 0)
    const message = harness.posts.at(-1)
    assert.equal(message?.type, 'settingsSaved')
    assert.equal((message as { restarting?: boolean }).restarting, false)
  } finally {
    await discard(harness)
  }
})

test('selectModel applies the saved model context window and restarts', async () => {
  const harness = await createHarness()
  try {
    await writeFile(
      join(harness.storage, 'models.json'),
      JSON.stringify({ version: 1, models: [{ id: 'saved-model', contextWindow: 12345, reasoningEfforts: ['low'] }] }),
      'utf8',
    )

    assert.equal(await harness.controller.selectModel({ type: 'selectModel', model: 'saved-model' }), true)
    assert.equal(vscode.values.get('deepseekHarness.model'), 'saved-model')
    assert.equal(vscode.values.get('deepseekHarness.contextWindow'), 12345)
    assert.equal(harness.starts.length + harness.restarts.length, 1)

    assert.equal(await harness.controller.selectModel({ type: 'selectModel', model: '  ' }), false, 'an empty selection is a no-op')
    assert.equal(await harness.controller.selectModel({ type: 'selectModel', model: 'not-saved' }), false)
    assert.equal(harness.errors.length, 1)
    assert.equal(harness.starts.length + harness.restarts.length, 1, 'failed selections never touch the runtime')
  } finally {
    await discard(harness)
  }
})

test('setSandboxMode persists the mode and applies it to a ready runtime', async () => {
  const stopped = await createHarness('stopped')
  try {
    await stopped.controller.setSandboxMode({ type: 'setSandboxMode', sandboxMode: 'read-only' })
    assert.deepEqual(stopped.errors, [])
    assert.equal(vscode.values.get('deepseekHarness.sandboxMode'), 'read-only')
    assert.equal(stopped.sandboxCalls.length, 0, 'a stopped runtime takes the mode on its next start')
    assert.equal(stopped.restarts.length, 0)
  } finally {
    await discard(stopped)
  }

  const ready = await createHarness('ready')
  try {
    await ready.controller.setSandboxMode({ type: 'setSandboxMode', sandboxMode: 'workspace-write' })
    assert.deepEqual(ready.sandboxCalls, [['session-1', 'workspace-write']])
    assert.equal(ready.restarts.length, 0)
  } finally {
    await discard(ready)
  }
})

test('fetchModels without a base URL reports the built-in list only', async () => {
  const harness = await createHarness()
  vscode.values.set('deepseekHarness.provider', 'llama')
  vscode.values.set('deepseekHarness.baseUrl', '')
  try {
    await harness.controller.fetchModels()
    assert.deepEqual(harness.errors, [])
    const message = harness.posts.at(-1)
    assert.equal(message?.type, 'discoveredModels')
    assert.equal((message as { models?: unknown[] }).models?.length, 0)
    assert.match(String((message as { error?: string }).error), /Set an API base URL/)
  } finally {
    vscode.values.delete('deepseekHarness.provider')
    vscode.values.delete('deepseekHarness.baseUrl')
    await discard(harness)
  }
})

test('loadModelCatalog posts the saved catalog and surfaces read failures', async () => {
  const harness = await createHarness()
  try {
    await writeFile(
      join(harness.storage, 'models.json'),
      JSON.stringify({ version: 1, models: [{ id: 'saved-model', contextWindow: 999 }] }),
      'utf8',
    )
    await harness.controller.loadModelCatalog()
    let message = harness.posts.at(-1)
    assert.equal(message?.type, 'modelCatalog')
    assert.equal((message as { models?: Array<{ id: string }> }).models?.[0]?.id, 'saved-model')
    assert.equal((message as { error?: string }).error, undefined)

    await writeFile(join(harness.storage, 'models.json'), '{ not json', 'utf8')
    await harness.controller.loadModelCatalog()
    message = harness.posts.at(-1)
    assert.equal(message?.type, 'modelCatalog')
    assert.deepEqual((message as { models?: unknown[] }).models, [])
    assert.match(String((message as { error?: string }).error), /Could not read the models file/)
  } finally {
    await discard(harness)
  }
})
