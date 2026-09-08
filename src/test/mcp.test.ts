import assert from 'node:assert/strict'
import test from 'node:test'
import { builtInWebPatchLines, mcpEnvironmentVariable, mcpPatchLines, mcpSecretKey } from '../runtime/mcp.js'

test('disables DSH built-in web tools', () => {
  assert.deepEqual(builtInWebPatchLines(), [
    '- id: web',
    '  disabled: true',
    '- id: web-search-deepseek',
    '  disabled: true',
    '- id: web-fetch-http',
    '  disabled: true',
    '- id: tool-web',
    '  disabled: true',
  ])
})

test('builds a Docker stdio MCP patch without embedding secret values', () => {
  const environmentVariable = mcpEnvironmentVariable('duckduckgo', 'DDG_TOKEN')
  const lines = mcpPatchLines([{
    serverName: 'duckduckgo',
    transport: 'stdio',
    command: 'docker',
    args: ['run', '-i', '--rm', 'mcp/duckduckgo'],
    env: { DDG_TOKEN: 'secret-value' },
  }])

  assert.deepEqual(lines.slice(0, 11), [
    '- insert:',
    '    - id: "mcp-duckduckgo"',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: "duckduckgo"',
    '        transport: "stdio"',
    '        failOnStartupError: true',
    '        command: "docker"',
    '        args:',
    '          - "run"',
    '          - "-i"',
  ])
  assert.ok(lines.includes('          - "mcp/duckduckgo"'))
  assert.ok(lines.includes(`          DDG_TOKEN: !!js process.env.${environmentVariable}`))
  assert.ok(!lines.some((line) => line.includes('secret-value')))
  assert.match(mcpSecretKey('duckduckgo', 'DDG_TOKEN'), /^deepseekHarness\.mcp\./)
})

test('emits an empty args array for a command without arguments', () => {
  assert.deepEqual(mcpPatchLines([{
    serverName: 'local',
    transport: 'stdio',
    command: 'my-mcp-server',
    args: [],
    env: {},
  }]), [
    '- insert:',
    '    - id: "mcp-local"',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: "local"',
    '        transport: "stdio"',
    '        failOnStartupError: true',
    '        command: "my-mcp-server"',
    '        args: []',
  ])
})
