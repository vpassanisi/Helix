import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import type { SidebarMessage } from '../sidebar/sidebar-provider.js'
import type { SettingsControllerOptions } from '../host/settings-controller.js'

// Isolated VS Code API fixture: exercise the real controller, config writes, and rollback.
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === 'vscode' ? { url: 'mock:vscode', shortCircuit: true } : next(specifier, context) },
  load(url, context, next) {
    if (url !== 'mock:vscode') return next(url, context)
    return { format: 'module', shortCircuit: true, source: `
      export const values = new Map();
      export const ConfigurationTarget = { Global: 1 };
      export const Uri = { joinPath: (uri, name) => ({ fsPath: uri.fsPath + '/' + name }) };
      export const env = { appRoot: '/tmp' };
      export const window = { showWarningMessage() {} };
      export const workspace = { workspaceFolders: [], fs: { readFile: async () => { const e = new Error('missing'); e.code = 'FileNotFound'; throw e } },
        getConfiguration: (prefix) => ({ get: (key, fallback) => values.get(prefix ? prefix + '.' + key : key) ?? fallback,
          update: async (key, value) => { values.set(key, value) } }) };
    ` }
  },
})
const { SettingsController } = await import('../host/settings-controller.js')
const vscode = await import('vscode') as unknown as { values: Map<string, unknown> }

test('connection settings persist separate secrets and roll back both settings and keys on failure', async () => {
  const values = vscode.values
  values.clear()
  values.set('deepseekHarness.experimentalSkillPicker', true)
  values.set('deepseekHarness.baseUrl', 'https://main.example.com')
  const secrets = new Map([['deepseekHarness.apiKey', 'main-key'], ['deepseekHarness.decisionsApiKey', 'old-decision-key']])
  const errors: unknown[] = []
  let failStore = false
  const controller = new SettingsController({
    context: { globalStorageUri: { fsPath: '/tmp/helix-settings-test' }, globalState: { get: (_key: string, fallback: unknown) => fallback },
      secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => {
        if (failStore && value === 'fail') throw new Error('secret store failed')
        secrets.set(key, value)
      }, delete: async (key: string) => { secrets.delete(key) } } },
    runtime: { start: async () => undefined, restart: async () => undefined }, sidebar: { post: () => undefined },
    getRuntimeState: () => 'stopped', getActiveSessionId: () => 'session', onError: (error: unknown) => errors.push(error),
  } as unknown as SettingsControllerOptions)
  const message: Extract<SidebarMessage, { type: 'saveSettings' }> = { type: 'saveSettings', provider: 'deepseek-official', baseUrl: 'https://main.example.com', clearApiKey: false, sandboxMode: 'read-only',
    decisions: { enabled: true, useMainConnection: false, format: 'typesafe', baseUrl: 'http://localhost:8080', model: 'local-decision' }, decisionsApiKey: 'separate-key' }
  await controller.saveSettings(message)
  assert.deepEqual(errors, [])
  await controller.saveSettings({ ...message, decisions: { ...message.decisions!, apiKeyConfigured: true } as typeof message.decisions })
  assert.equal('apiKeyConfigured' in (values.get('deepseekHarness.decisions') as object), false, 'Only configuration fields are persisted')
  assert.equal((await controller.decisionConnection()).apiKey, 'separate-key')
  assert.equal((await controller.decisionConnection()).baseUrl, 'http://localhost:8080')
  assert.equal(secrets.get('deepseekHarness.apiKey'), 'main-key')
  assert.equal((await controller.getSidebarSettings()).decisions?.apiKeyConfigured, true)

  await controller.saveSettings({ ...message, decisions: { ...message.decisions!, useMainConnection: true }, decisionsApiKey: undefined })
  assert.equal((await controller.decisionConnection()).apiKey, 'main-key')
  assert.equal((await controller.decisionConnection()).baseUrl, 'https://main.example.com')
  const before = values.get('deepseekHarness.decisions')
  failStore = true
  await controller.saveSettings({ ...message, baseUrl: 'https://changed.example.com', apiKey: 'changed-main-key', decisionsApiKey: 'fail' })
  assert.equal(errors.length, 1)
  assert.equal(values.get('deepseekHarness.baseUrl'), 'https://main.example.com')
  assert.deepEqual(values.get('deepseekHarness.decisions'), before)
  assert.equal(secrets.get('deepseekHarness.apiKey'), 'main-key')
  assert.equal(secrets.get('deepseekHarness.decisionsApiKey'), 'separate-key')

  failStore = false
  await controller.saveSettings({ ...message, decisionsApiKey: undefined, clearDecisionsApiKey: true })
  assert.equal((await controller.decisionConnection()).apiKey, undefined, 'separate connections never inherit the main key')
  assert.equal(secrets.get('deepseekHarness.apiKey'), 'main-key')
  await controller.saveSettings({ ...message, decisions: { ...message.decisions!, model: '' } })
  assert.match(String(errors.at(-1)), /model ID is required/)
})

test('the feature flag defaults off, masks routing, and preserves dormant decisions settings and secrets', async () => {
  const values = vscode.values
  values.clear()
  const saved = { enabled: true, useMainConnection: false, format: 'typesafe', baseUrl: 'http://localhost:8080', model: 'saved-decision-model' }
  values.set('deepseekHarness.decisions', saved)
  const secrets = new Map([['deepseekHarness.decisionsApiKey', 'saved-key']])
  const errors: unknown[] = []
  const controller = new SettingsController({
    context: { globalStorageUri: { fsPath: '/tmp/helix-settings-test' }, globalState: { get: (_key: string, fallback: unknown) => fallback },
      secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value) },
        delete: async (key: string) => { secrets.delete(key) } } },
    runtime: { start: async () => undefined, restart: async () => undefined }, sidebar: { post: () => undefined },
    getRuntimeState: () => 'stopped', getActiveSessionId: () => 'session', onError: (error: unknown) => errors.push(error),
  } as unknown as SettingsControllerOptions)
  assert.equal(controller.skillPickerEnabled(), false)
  assert.equal((await controller.getSidebarSettings()).skillPickerEnabled, false)
  assert.equal((await controller.decisionConnection()).enabled, false)
  await controller.saveSettings({ type: 'saveSettings', provider: 'deepseek-official', baseUrl: 'https://main.example.com',
    clearApiKey: false, sandboxMode: 'read-only', decisions: { ...saved, format: 'typesafe', model: '' }, clearDecisionsApiKey: true })
  assert.deepEqual(errors, [], 'Hidden decisions settings cannot block saving the main connection')
  assert.deepEqual(values.get('deepseekHarness.decisions'), saved)
  assert.equal(secrets.get('deepseekHarness.decisionsApiKey'), 'saved-key')
  values.set('deepseekHarness.experimentalSkillPicker', true)
  assert.equal((await controller.getSidebarSettings()).skillPickerEnabled, true)
  assert.equal((await controller.decisionConnection()).enabled, true)
  assert.equal((await controller.decisionConnection()).model, 'saved-decision-model')
  assert.equal((await controller.decisionConnection()).apiKey, 'saved-key')
})

test.after(() => hooks.deregister())
