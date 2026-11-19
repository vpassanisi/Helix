import { createHash } from 'node:crypto'

export type McpTransport = 'stdio' | 'streamable-http'

export interface PersistedMcpServer {
  serverName: string
  transport: McpTransport
  command?: string
  args: string[]
  url?: string
  envKeys: string[]
  /**
   * `false` keeps the saved server in settings but leaves its entry switched
   * off in the runtime. The key is absent for an enabled server, so settings
   * written before this option existed need no migration.
   */
  enabled?: boolean
}

export interface RuntimeMcpServer {
  serverName: string
  transport: McpTransport
  command?: string
  args: string[]
  url?: string
  env: Record<string, string>
  /** Only `false` is meaningful: the entry runs when the key is absent. */
  enabled?: boolean
}

export function mcpServerId(serverName: string): string {
  return `mcp-${serverName}`
}

export function mcpEnvironmentVariable(serverName: string, environmentName: string): string {
  const digest = createHash('sha256')
    .update(`${serverName}\0${environmentName}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()
  const serverPart = serverName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  const environmentPart = environmentName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  return `DSH_MCP_${serverPart}_${environmentPart}_${digest}`
}

export function mcpSecretKey(serverName: string, environmentName: string): string {
  return `deepseekHarness.mcp.${encodeURIComponent(serverName)}.${encodeURIComponent(environmentName)}`
}

export function mcpPatchLines(servers: RuntimeMcpServer[]): string[] {
  if (servers.length === 0) return []
  const lines: string[] = ['- insert:']

  for (const server of servers) lines.push(...mcpServerPatchLines(server))

  return lines
}

function mcpServerPatchLines(server: RuntimeMcpServer): string[] {
  const lines = [
    `    - id: ${yamlString(mcpServerId(server.serverName))}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
  ]

  // A loader entry honours `disabled`, so a saved server can stay configured
  // while the runtime leaves it out. An enabled server writes no row at all.
  if (server.enabled === false) lines.push('      disabled: true')

  lines.push(
    '      config:',
    `        serverName: ${yamlString(server.serverName)}`,
    `        transport: ${yamlString(server.transport)}`,
    '        failOnStartupError: false',
  )

  if (server.transport === 'stdio') {
    lines.push(`        command: ${yamlString(server.command ?? '')}`)
    lines.push(server.args.length === 0 ? '        args: []' : '        args:')
    if (server.args.length > 0) lines.push(...server.args.map((argument) => `          - ${yamlString(argument)}`))
  } else {
    lines.push(`        url: ${yamlString(server.url ?? '')}`)
  }

  const environmentEntries = Object.keys(server.env)
  if (environmentEntries.length > 0) {
    lines.push('        env:')
    for (const environmentName of environmentEntries) {
      lines.push(`          ${environmentName}: !!js process.env.${mcpEnvironmentVariable(server.serverName, environmentName)}`)
    }
  }

  return lines
}

export function builtInWebPatchLines(): string[] {
  return [
    '- id: web',
    '  disabled: true',
    '- id: web-search-deepseek',
    '  disabled: true',
    '- id: web-fetch-http',
    '  disabled: true',
    '- id: web-deepseek-api',
    '  disabled: true',
    '- id: tool-web',
    '  disabled: true',
  ]
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}
