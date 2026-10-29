import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import type { SidebarMcpServer } from '../sidebar/sidebar-protocol.js'

// Isolated VS Code API fixture: configuration reads come from a values Map.
const hooks = registerHooks({
  resolve(specifier, context, next) { return specifier === 'vscode' ? { url: 'mock:vscode', shortCircuit: true } : next(specifier, context) },
  load(url, context, next) {
    if (url !== 'mock:vscode') return next(url, context)
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export const values = new Map();
        export const workspace = {
          getConfiguration: (prefix) => ({
            get: (key, fallback) => values.get(prefix ? prefix + '.' + key : key) ?? fallback,
            update: async (key, value) => { values.set(key, value) },
          }),
        };
      `,
    }
  },
})
const {
  configuredMcpServers,
  normalizeMcpServers,
  runtimeMcpServers,
  sidebarMcpServers,
  syncMcpSecrets,
  validateHttpUrl,
  validateMcpSecretReferences,
} = await import('../host/mcp-settings.js')
const { mcpSecretKey } = await import('../runtime/mcp.js')
const vscode = await import('vscode') as unknown as { values: Map<string, unknown> }

interface SecretStore {
  store: Map<string, string>
  deleted: string[]
  api: {
    get: (key: string) => Promise<string | undefined>
    store: (key: string, value: string) => Promise<void>
    delete: (key: string) => Promise<void>
  }
}

function secretStore(initial: Record<string, string> = {}): SecretStore {
  const store = new Map(Object.entries(initial))
  const deleted: string[] = []
  return {
    store,
    deleted,
    api: {
      get: async (key) => store.get(key),
      store: async (key, value) => { store.set(key, value) },
      delete: async (key) => { store.delete(key); deleted.push(key) },
    },
  }
}

function server(overrides: Partial<SidebarMcpServer> = {}): SidebarMcpServer {
  return {
    serverName: 'files',
    transport: 'stdio',
    command: '/usr/bin/mcp-files',
    args: ['--root', '/data'],
    url: '',
    env: [{ name: 'API_KEY', value: 'secret' }],
    ...overrides,
  }
}

test('validateHttpUrl accepts http/https and rejects other schemes', () => {
  validateHttpUrl('', 'MCP server URL')
  validateHttpUrl('http://localhost:3000', 'MCP server URL')
  validateHttpUrl('https://mcp.example.com', 'MCP server URL')
  assert.throws(() => validateHttpUrl('ftp://files.example.com', 'MCP server URL'), /HTTP or HTTPS/)
  assert.throws(() => validateHttpUrl('not a url', 'MCP server URL'), /valid HTTP or HTTPS URL/)
})

test('configuredMcpServers only accepts persisted entries in the saved shape', () => {
  const values = vscode.values
  values.clear()
  values.set('deepseekHarness.mcpServers', [
    { serverName: 'files', transport: 'stdio', command: '/usr/bin/mcp-files', args: ['--root'], url: '', envKeys: ['API_KEY'] },
    { serverName: 'remote', transport: 'streamable-http', args: [], url: 'https://mcp.example.com', envKeys: [] },
    { serverName: 'broken', transport: 'stdio', args: 'not-an-array', envKeys: [] },
    { transport: 'stdio', command: '/bin/x', args: [], envKeys: [] },
    'junk',
  ])

  const servers = configuredMcpServers()
  assert.equal(servers.length, 2, 'malformed entries are dropped, not thrown')
  assert.deepEqual(servers[0], { serverName: 'files', transport: 'stdio', command: '/usr/bin/mcp-files', args: ['--root'], url: '', envKeys: ['API_KEY'] })
  assert.equal(servers[1].url, 'https://mcp.example.com')
  assert.equal(servers[1].command, undefined)

  values.set('deepseekHarness.mcpServers', 'not-an-array')
  assert.deepEqual(configuredMcpServers(), [])
})

test('runtimeMcpServers resolves the secret values behind each env key', async () => {
  const values = vscode.values
  values.clear()
  values.set('deepseekHarness.mcpServers', [
    { serverName: 'files', transport: 'stdio', command: '/usr/bin/mcp-files', args: [], url: '', envKeys: ['API_KEY', 'MISSING'] },
  ])
  const secrets = secretStore({ [mcpSecretKey('files', 'API_KEY')]: 'resolved-key' })

  const servers = await runtimeMcpServers(secrets.api as never)
  assert.equal(servers.length, 1)
  assert.deepEqual(servers[0].env, { API_KEY: 'resolved-key' }, 'unset secrets are omitted, not empty')
})

test('sidebarMcpServers exposes only the configured flag', async () => {
  const values = vscode.values
  values.clear()
  values.set('deepseekHarness.mcpServers', [
    { serverName: 'files', transport: 'stdio', command: '/usr/bin/mcp-files', args: [], url: '', envKeys: ['API_KEY', 'EMPTY'] },
  ])
  const secrets = secretStore({ [mcpSecretKey('files', 'API_KEY')]: 'resolved-key' })

  const sidebar = await sidebarMcpServers(secrets.api as never)
  assert.equal(sidebar.length, 1)
  assert.equal(sidebar[0].serverName, 'files')
  assert.deepEqual(sidebar[0].env, [
    { name: 'API_KEY', configured: true },
    { name: 'EMPTY', configured: false },
  ])
  assert.equal('value' in (sidebar[0].env[0] as object), false, 'secret values never reach the sidebar')
})

test('normalizeMcpServers validates names, transports, and environment entries', () => {
  const normalized = normalizeMcpServers([
    server({ env: [{ name: ' API_KEY ', configured: true }, { name: 'TOKEN', value: 't' }] }),
    server({ serverName: 'remote', transport: 'streamable-http', command: '', args: [], url: 'https://mcp.example.com', env: [] }),
  ])
  assert.equal(normalized[0].serverName, 'files')
  assert.deepEqual(normalized[0].envKeys, ['API_KEY', 'TOKEN'])
  assert.equal(normalized[0].url, undefined)
  assert.equal(normalized[1].command, undefined)
  assert.equal(normalized[1].url, 'https://mcp.example.com')
  assert.deepEqual(normalized[1].envKeys, [])

  assert.throws(() => normalizeMcpServers([server({ serverName: 'bad name' })]), /needs a name/)
  assert.throws(() => normalizeMcpServers([server(), server({ serverName: 'files' })]), /duplicated/)
  assert.throws(() => normalizeMcpServers([server({ command: '' })]), /needs a command/)
  assert.throws(() => normalizeMcpServers([server({ serverName: 'remote', transport: 'streamable-http', command: '', args: [], url: 'not a url' })]), /valid HTTP or HTTPS URL/)
  assert.throws(() => normalizeMcpServers([server({ serverName: 'remote', transport: 'streamable-http', command: '', args: [], url: 'https://x', env: [{ name: 'K', value: 'v' }] })]), /stdio MCP servers only/)
  assert.throws(() => normalizeMcpServers([server({ env: [{ name: '9BAD', value: 'v' }] })]), /is invalid/)
  assert.throws(() => normalizeMcpServers([server({ env: [{ name: 'K', value: 'a' }, { name: 'K', value: 'b' }] })]), /duplicated/)
  assert.throws(() => normalizeMcpServers([server({ env: [{ name: 'K' }] })]), /Enter a value/)
})

test('validateMcpSecretReferences requires a value or a stored secret', async () => {
  const values = vscode.values
  values.clear()
  const secrets = secretStore()

  assert.rejects(
    validateMcpSecretReferences(secrets.api as never, [server({ env: [{ name: 'API_KEY', configured: true }] })]),
    /Enter a new value/,
  )
  await validateMcpSecretReferences(secrets.api as never, [server()])
  await validateMcpSecretReferences(
    secretStore({ [mcpSecretKey('files', 'API_KEY')]: 'v' }).api as never,
    [server({ env: [{ name: 'API_KEY', configured: true }] })],
  )
})

test('syncMcpSecrets stores new values and clears removed references', async () => {
  const values = vscode.values
  values.clear()
  values.set('deepseekHarness.mcpServers', [
    { serverName: 'gone', transport: 'stdio', command: '/usr/bin/x', args: [], url: '', envKeys: ['K'] },
    { serverName: 'kept', transport: 'stdio', command: '/usr/bin/x', args: [], url: '', envKeys: ['OLD', 'NEW'] },
  ])
  const secrets = secretStore({
    [mcpSecretKey('gone', 'K')]: 'gone-key',
    [mcpSecretKey('kept', 'OLD')]: 'old-key',
    [mcpSecretKey('kept', 'NEW')]: 'new-key',
  })

  const submitted = [
    server({ serverName: 'kept', command: '/usr/bin/x', env: [{ name: 'NEW', value: 'replaced' }] }),
    server({ serverName: 'fresh', command: '/usr/bin/f', env: [{ name: 'F', value: 'f-key' }] }),
  ]
  await syncMcpSecrets(secrets.api as never, normalizeMcpServers(submitted), submitted)

  assert.equal(secrets.store.get(mcpSecretKey('gone', 'K')), undefined)
  assert.ok(secrets.deleted.includes(mcpSecretKey('gone', 'K')))
  assert.ok(secrets.deleted.includes(mcpSecretKey('kept', 'OLD')), 'an env key dropped from the server loses its secret')
  assert.equal(secrets.store.get(mcpSecretKey('kept', 'NEW')), 'replaced')
  assert.equal(secrets.store.get(mcpSecretKey('fresh', 'F')), 'f-key')
})
