import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { HarnessClientOptions } from '@deepseek-ai/dsh-sdk-client'
import { resolveAdapterOptions, type DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
import type { ControlBroker } from './control-bridge.js'
import { builtInWebPatchLines, mcpEnvironmentVariable, mcpPatchLines } from './mcp.js'
import { pluginPatchLines } from './plugins.js'
import { GEN_UI_TOOL_BUNDLE_ID, REPORT_PROGRESS_TOOL_BUNDLE_ID, normalizeDisabledToolBundles, toolBundlePatchLines } from '../shared/tool-bundles.js'
import { piAiRuntimeModelProfiles, type ChatTemplateValue, type PiAiModelRuntimeProfile } from './model-catalog.js'
import type { RuntimeOptions } from './types.js'

export interface ContextPatch {
  path: string
  directory: string
}

/**
 * Builds the runtime patch: the DeepSeek/Pi-AI model catalog the session will
 * use, the Helix control plugins, the user's plugins, the sandbox policy and
 * the MCP servers. Kept out of the runtime class so the YAML can be tested
 * and read without starting a process.
 */
export function buildRuntimePatchLines(options: RuntimeOptions): string[] {
  const contextWindow = options.contextWindow
  const hasContextWindow = contextWindow !== undefined && Number.isSafeInteger(contextWindow) && contextWindow > 0

  const patchLines: string[] = []
  if (options.provider === 'deepseek-official' && (hasContextWindow || (options.savedModels?.length ?? 0) > 0)) {
    const catalog: DeepSeekCatalogModel[] = resolveAdapterOptions({}).models.map((model) => ({ ...model }))
    for (const saved of options.savedModels ?? []) {
      const existing = catalog.find((model) => model.id === saved.id)
      const model: DeepSeekCatalogModel = existing ?? { id: saved.id }
      if (existing === undefined) catalog.push(model)
      if (saved.displayName !== undefined) model.name = saved.displayName
      if (saved.contextWindow !== undefined) model.contextWindow = saved.contextWindow
      model.inputModalities = saved.acceptsImages === true ? ['text', 'image'] : ['text']
      if (saved.acceptsImages !== true) {
        model.imagePixelBudget = undefined
        model.imageMaxBytes = undefined
      }
    }
    if (hasContextWindow) {
      const active = catalog.find((model) => model.id === options.model)
      if (active !== undefined) active.contextWindow = contextWindow
      else catalog.push({ id: options.model, contextWindow })
    }
    patchLines.push('- id: llm-deepseek', '  config:')
    if (hasContextWindow) patchLines.push(`    defaultContextWindow: ${contextWindow}`)
    patchLines.push('    models:')
    for (const model of catalog) patchLines.push(...directDeepSeekModelYamlLines(model))
  } else if (hasContextWindow) {
    patchLines.push(
      '- id: llm-deepseek',
      '  config:',
      `    defaultContextWindow: ${contextWindow}`,
      '    models:',
      `      - id: ${yamlString(options.model)}`,
      `        contextWindow: ${contextWindow}`,
    )
  }
  if (options.provider !== 'deepseek-official') {
    const modelProfiles = piAiRuntimeModelProfiles(options.savedModels ?? [])
    patchLines.push(
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      `      ${yamlString(options.provider)}:`,
      '        api: openai-completions',
      '        apiKeyEnv: DEEPSEEK_API_KEY',
      '        baseURL: !!js process.env.DEEPSEEK_BASE_URL',
    )
    if (hasContextWindow && modelProfiles.length === 0) patchLines.push(`        defaultContextWindow: ${contextWindow}`)
    patchLines.push('        models:')
    if (modelProfiles.length > 0) {
      patchLines.push(...piAiModelProfilePatchLines(modelProfiles))
    } else {
      // Nothing is saved yet, so declare the id the model picker discovered from this endpoint.
      patchLines.push(`          - id: ${yamlString(options.model)}`)
      if (hasContextWindow) patchLines.push(`            contextWindow: ${contextWindow}`)
      patchLines.push('            input: ["text"]')
    }
  }
  patchLines.push(
    '- insert:',
    '    - id: helix-control-bridge',
    `      name: ${yamlString(new URL('./dsh-control-plugin.js', import.meta.url).href)}`,
    '      config:',
    `        cwd: ${yamlString(options.cwd)}`,
    '    - id: helix-question-tool',
    `      name: ${yamlString(new URL('./dsh-question-tool-plugin.js', import.meta.url).href)}`,
    '    - id: helix-report-progress-tool',
    `      name: ${yamlString(new URL('./dsh-report-progress-plugin.js', import.meta.url).href)}`,
    '      config:',
    `        enabled: ${!normalizeDisabledToolBundles(options.disabledToolBundles ?? []).includes(REPORT_PROGRESS_TOOL_BUNDLE_ID)}`,
    '    - id: helix-gen-ui-tool',
    `      name: ${yamlString(new URL('./dsh-gen-ui-tool-plugin.js', import.meta.url).href)}`,
    '      config:',
    // Helix's own bundle is mounted by a Helix plugin, so its Tools-page
    // switch arrives as config rather than a runtime disable row: the plugin
    // then takes out both the tool and its prompt section.
    `        enabled: ${!normalizeDisabledToolBundles(options.disabledToolBundles ?? []).includes(GEN_UI_TOOL_BUNDLE_ID)}`,
  )
  patchLines.push(...pluginPatchLines(options.plugins ?? []))
  if (options.sessionStorageRoot !== undefined) {
    patchLines.push(
      '- id: sessions',
      '  config:',
      `    root: ${yamlString(options.sessionStorageRoot)}`,
    )
  }
  patchLines.push(...builtInWebPatchLines())
  patchLines.push(...toolBundlePatchLines(options.disabledToolBundles ?? []))
  patchLines.push(
    '- id: sandbox-policy',
    '  config:',
    `    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`,
    `    workspaceRoot: ${yamlString(options.cwd)}`,
  )
  patchLines.push(...mcpPatchLines(options.mcpServers))
  return patchLines
}

export async function createRuntimePatch(options: RuntimeOptions): Promise<ContextPatch> {
  const patch = `${buildRuntimePatchLines(options).join('\n')}\n`

  const directory = await mkdtemp(join(tmpdir(), 'dsh-vscode-'))
  const patchPath = join(directory, 'runtime.patch.yml')
  try {
    await writeFile(patchPath, patch, 'utf8')
    return { path: patchPath, directory }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export function createClientOptions(
  options: RuntimeOptions,
  controlBridge: ControlBroker,
  contextPatch: ContextPatch | undefined,
): HarnessClientOptions {
  const env = createRuntimeEnvironment(options, controlBridge)
  return {
    dshBin: options.dshBin,
    profile: 'sdk',
    patches: contextPatch === undefined ? undefined : [contextPatch.path],
    dshHome: options.dshHome,
    processCwd: options.cwd,
    env,
  }
}

export function createRuntimeEnvironment(options: RuntimeOptions, controlBridge: ControlBroker): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HELIX_CONTROL_ENDPOINT: controlBridge.endpoint,
    HELIX_CONTROL_TOKEN: controlBridge.token,
    DSH_PERMISSION_MODE: options.sandboxMode,
  }
  if (options.dshHome !== undefined) env.DSH_HOME = options.dshHome
  if (options.apiKey !== undefined) env.DEEPSEEK_API_KEY = options.apiKey
  if (options.baseUrl !== undefined) env.DEEPSEEK_BASE_URL = runtimeBaseUrl(options.provider, options.baseUrl)
  for (const server of options.mcpServers) {
    for (const [environmentName, value] of Object.entries(server.env)) {
      env[mcpEnvironmentVariable(server.serverName, environmentName)] = value
    }
  }
  return env
}

function runtimeBaseUrl(provider: string, baseUrl: string): string {
  if (provider !== 'deepseek-official') return baseUrl
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  if (url.hostname === 'api.deepseek.com' && (path === '' || path === '/v1')) {
    url.pathname = '/anthropic'
    return url.toString().replace(/\/$/, '')
  }
  return baseUrl
}

export function piAiModelProfilePatchLines(modelProfiles: PiAiModelRuntimeProfile[]): string[] {
  const lines: string[] = []
  for (const profile of modelProfiles) {
    lines.push(`          - id: ${yamlString(profile.id)}`)
    if (profile.name !== undefined) lines.push(`            name: ${yamlString(profile.name)}`)
    if (profile.contextWindow !== undefined) lines.push(`            contextWindow: ${profile.contextWindow}`)
    lines.push(`            input: [${profile.input.map(yamlString).join(', ')}]`)
    if (profile.reasoningEfforts === false) {
      lines.push('            reasoningEfforts: false')
    } else if (profile.reasoningEfforts !== undefined) {
      lines.push('            reasoningEfforts:')
      for (const [level, wireValue] of Object.entries(profile.reasoningEfforts)) {
        lines.push(`              ${yamlString(level)}: ${wireValue === null ? 'null' : yamlString(wireValue)}`)
      }
    }
    if (profile.compat !== undefined) {
      lines.push('            compat:')
      if (profile.compat.thinkingFormat !== undefined) {
        lines.push(`              thinkingFormat: ${yamlString(profile.compat.thinkingFormat)}`)
      }
      if (profile.compat.supportsReasoningEffort !== undefined) {
        lines.push(`              supportsReasoningEffort: ${profile.compat.supportsReasoningEffort}`)
      }
      if (profile.compat.chatTemplateKwargs !== undefined) {
        lines.push('              chatTemplateKwargs:')
        lines.push(...chatTemplateYamlLines(profile.compat.chatTemplateKwargs, 16))
      }
      if (profile.compat.chatTemplateArgs !== undefined) {
        lines.push('              chatTemplateArgs:')
        lines.push(...chatTemplateYamlLines(profile.compat.chatTemplateArgs, 16))
      }
    }
  }
  return lines
}

export function yamlString(value: string): string {
  return JSON.stringify(value)
}

function directDeepSeekModelYamlLines(model: DeepSeekCatalogModel): string[] {
  const lines = [`      - id: ${yamlString(model.id)}`]
  if (model.name !== undefined) lines.push(`        name: ${yamlString(model.name)}`)
  if (model.description !== undefined) lines.push(`        description: ${yamlString(model.description)}`)
  if (model.contextWindow !== undefined) lines.push(`        contextWindow: ${model.contextWindow}`)
  if (model.maxTokens !== undefined) lines.push(`        maxTokens: ${model.maxTokens}`)
  if (model.inputModalities !== undefined) {
    lines.push(`        inputModalities: [${model.inputModalities.map(yamlString).join(', ')}]`)
  }
  if (model.imagePixelBudget !== undefined) lines.push(`        imagePixelBudget: ${yamlScalar(model.imagePixelBudget)}`)
  if (model.imageMaxBytes !== undefined) lines.push(`        imageMaxBytes: ${model.imageMaxBytes}`)
  if (model.systemPromptUpdate !== undefined) lines.push(`        systemPromptUpdate: ${yamlString(model.systemPromptUpdate)}`)
  return lines
}

function chatTemplateYamlLines(values: Record<string, ChatTemplateValue>, indentation: number): string[] {
  const prefix = ' '.repeat(indentation)
  return Object.entries(values).flatMap(([key, value]) => {
    const keyLine = `${prefix}${yamlString(key)}:`
    if (typeof value === 'object' && value !== null) {
      return [
        keyLine,
        `${prefix}  $var: ${yamlString(value.$var)}`,
        ...(value.omitWhenOff === undefined ? [] : [`${prefix}  omitWhenOff: ${value.omitWhenOff}`]),
      ]
    }
    return [`${keyLine} ${yamlScalar(value)}`]
  })
}

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return yamlString(value)
  return String(value)
}
