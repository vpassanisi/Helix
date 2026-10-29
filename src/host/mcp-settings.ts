import * as vscode from 'vscode'
import { mcpSecretKey } from '../runtime/mcp.js'
import type { PersistedMcpServer, RuntimeMcpServer } from '../runtime/types.js'
import { isRecord } from '../shared/value-utils.js'
import type { SidebarMcpServer, SidebarMcpServerSetting } from '../sidebar/sidebar-provider.js'

const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const MCP_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateHttpUrl(value: string, label: string): void {
  if (!value) return
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${label} must use HTTP or HTTPS.`)
}

/**
 * The MCP servers the user has saved, exactly as persisted: names, commands,
 * URLs and the *names* of the secret-backed environment variables. The secret
 * values live in the secret store, never in settings.
 */
export function configuredMcpServers(): PersistedMcpServer[] {
  const values = vscode.workspace.getConfiguration('deepseekHarness').get<unknown[]>('mcpServers', [])
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    if (!isRecord(value) || typeof value.serverName !== 'string' ||
      (value.transport !== 'stdio' && value.transport !== 'streamable-http') ||
      !Array.isArray(value.args) || !value.args.every((argument) => typeof argument === 'string') ||
      !Array.isArray(value.envKeys) || !value.envKeys.every((key) => typeof key === 'string')) return []
    return [{
      serverName: value.serverName,
      transport: value.transport,
      command: typeof value.command === 'string' ? value.command : undefined,
      args: value.args,
      url: typeof value.url === 'string' ? value.url : undefined,
      envKeys: value.envKeys,
    } satisfies PersistedMcpServer]
  })
}

/** The same servers with their secret values resolved, ready for the runtime. */
export async function runtimeMcpServers(secrets: vscode.SecretStorage): Promise<RuntimeMcpServer[]> {
  return Promise.all(configuredMcpServers().map(async (server) => {
    const entries = await Promise.all(server.envKeys.map(async (environmentName) => {
      const value = await secrets.get(mcpSecretKey(server.serverName, environmentName))
      return value === undefined ? undefined : [environmentName, value] as const
    }))
    return {
      serverName: server.serverName,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      env: Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== undefined)),
    }
  }))
}

/** The same servers in the shape the sidebar shows: values hidden, only a "configured" flag. */
export async function sidebarMcpServers(secrets: vscode.SecretStorage): Promise<SidebarMcpServerSetting[]> {
  return Promise.all(configuredMcpServers().map(async (server) => ({
    serverName: server.serverName,
    transport: server.transport,
    command: server.command ?? '',
    args: server.args,
    url: server.url ?? '',
    env: await Promise.all(server.envKeys.map(async (name) => ({
      name,
      configured: Boolean(await secrets.get(mcpSecretKey(server.serverName, name))),
    }))),
  })))
}

export function normalizeMcpServers(servers: SidebarMcpServer[]): PersistedMcpServer[] {
  const seenServerNames = new Set<string>()
  return servers.map((server, index) => {
    const normalized = normalizeMcpServer(server, index)
    if (seenServerNames.has(normalized.serverName)) throw new Error(`MCP server name "${normalized.serverName}" is duplicated.`)
    seenServerNames.add(normalized.serverName)
    return normalized
  })
}

/**
 * A variable that shows "already configured" but carries no new value must
 * still resolve to a stored secret, otherwise the saved server would silently
 * lose its environment.
 */
export async function validateMcpSecretReferences(secrets: vscode.SecretStorage, servers: SidebarMcpServer[]): Promise<void> {
  for (const server of servers) {
    for (const environment of server.env) {
      const name = environment.name.trim()
      if (!name || environment.value || !environment.configured) continue
      const savedValue = await secrets.get(mcpSecretKey(server.serverName.trim(), name))
      if (savedValue === undefined) {
        throw new Error(`Enter a new value for environment variable "${name}" in MCP server "${server.serverName.trim()}".`)
      }
    }
  }
}

/**
 * Reconciles the secret store with the submitted list: drops secrets for
 * removed servers and variables, stores newly typed values. Untouched
 * "configured" entries keep their stored secrets.
 */
export async function syncMcpSecrets(
  secrets: vscode.SecretStorage,
  nextServers: PersistedMcpServer[],
  submittedServers: SidebarMcpServer[],
): Promise<void> {
  const previousServers = configuredMcpServers()
  const nextKeys = new Set(nextServers.flatMap((server) => server.envKeys.map((name) => `${server.serverName}\0${name}`)))
  for (const server of previousServers) {
    for (const name of server.envKeys) {
      if (!nextKeys.has(`${server.serverName}\0${name}`)) {
        await secrets.delete(mcpSecretKey(server.serverName, name))
      }
    }
  }
  for (const server of submittedServers) {
    for (const environment of server.env) {
      if (environment.name.trim() && environment.value) {
        await secrets.store(
          mcpSecretKey(server.serverName.trim(), environment.name.trim()),
          environment.value,
        )
      }
    }
  }
}

function normalizeMcpServer(server: SidebarMcpServer, index: number): PersistedMcpServer {
  const serverName = server.serverName.trim()
  if (!MCP_SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`MCP server ${index + 1} needs a name using only letters, numbers, hyphens, or underscores.`)
  }
  const args = server.args.filter((argument) => argument.length > 0)
  const command = server.command.trim()
  const url = server.url.trim()
  if (server.transport === 'stdio' && !command) throw new Error(`MCP server "${serverName}" needs a command.`)
  if (server.transport === 'streamable-http') {
    validateHttpUrl(url, `MCP server "${serverName}" URL`)
    if (!url) throw new Error(`MCP server "${serverName}" needs a URL.`)
  }

  const seenEnvironmentNames = new Set<string>()
  if (server.transport === 'streamable-http' && server.env.some((entry) => entry.name.trim())) {
    throw new Error(`Environment variables are currently supported for stdio MCP servers only. Remove them from "${serverName}".`)
  }
  const envKeys = server.env.flatMap((entry) => {
    const name = entry.name.trim()
    if (!name) return []
    if (!MCP_ENVIRONMENT_NAME_PATTERN.test(name)) throw new Error(`Environment variable "${name}" in MCP server "${serverName}" is invalid.`)
    if (seenEnvironmentNames.has(name)) throw new Error(`Environment variable "${name}" in MCP server "${serverName}" is duplicated.`)
    if (!entry.value && !entry.configured) throw new Error(`Enter a value for environment variable "${name}" in MCP server "${serverName}", or remove it.`)
    seenEnvironmentNames.add(name)
    return [name]
  })

  return {
    serverName,
    transport: server.transport,
    command: server.transport === 'stdio' ? command : undefined,
    args,
    url: server.transport === 'streamable-http' ? url : undefined,
    envKeys,
  }
}
