import { createHash } from 'node:crypto'

export type McpTransport = 'stdio' | 'streamable-http'

export interface PersistedMcpServer {
  serverName: string
  transport: McpTransport
  command?: string
  args: string[]
  url?: string
  envKeys: string[]
}

export interface RuntimeMcpServer {
  serverName: string
  transport: McpTransport
  command?: string
  args: string[]
  url?: string
  env: Record<string, string>
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

  for (const server of servers) {
    lines.push(
      `    - id: ${yamlString(mcpServerId(server.serverName))}`,
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      `        serverName: ${yamlString(server.serverName)}`,
      `        transport: ${yamlString(server.transport)}`,
      '        failOnStartupError: true',
    )

    if (server.transport === 'stdio') {
      lines.push(`        command: ${yamlString(server.command ?? '')}`)
      if (server.args.length === 0) {
        lines.push('        args: []')
      } else {
        lines.push('        args:', ...server.args.map((argument) => `          - ${yamlString(argument)}`))
      }
    } else {
      lines.push(`        url: ${yamlString(server.url ?? '')}`)
    }

    const environmentEntries = Object.entries(server.env)
    if (environmentEntries.length > 0) {
      lines.push('        env:')
      for (const [environmentName] of environmentEntries) {
        lines.push(
          `          ${environmentName}: !!js process.env.${mcpEnvironmentVariable(server.serverName, environmentName)}`,
        )
      }
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
    '- id: tool-web',
    '  disabled: true',
  ]
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}
