import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRecord, stringValue } from '../shared/value-utils.js'
import type { RuntimePluginBundle } from './types.js'

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export function createOtelTracingPlugin(extensionPath: string, config: unknown): RuntimePluginBundle {
  return {
    id: 'dsh-otel-tracing',
    modulePath: join(extensionPath, 'out', 'plugins', 'dsh-otel-plugin', 'index.mjs'),
    config: isRecord(config) ? config : {},
  }
}

export function configuredPluginBundles(value: unknown, extensionPath: string): RuntimePluginBundle[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index) => {
    if (!isRecord(entry) || entry.enabled !== true) return []
    const id = stringValue(entry.id)?.trim()
    const modulePath = stringValue(entry.path)?.trim()
    if (!id || !PLUGIN_ID_PATTERN.test(id)) {
      throw new Error(`Additional DSH plugin ${index + 1} needs a lowercase plugin ID.`)
    }
    if (!modulePath) throw new Error(`Additional DSH plugin "${id}" needs a local bundle path.`)
    if (entry.config !== undefined && !isRecord(entry.config)) {
      throw new Error(`Configuration for additional DSH plugin "${id}" must be an object.`)
    }
    return [{
      id,
      modulePath: resolve(extensionPath, modulePath),
      config: isRecord(entry.config) ? entry.config : {},
    }]
  })
}

export function pluginPatchLines(plugins: RuntimePluginBundle[]): string[] {
  const seen = new Set<string>()
  return plugins.flatMap((plugin) => {
    if (!PLUGIN_ID_PATTERN.test(plugin.id)) throw new Error(`Invalid DSH plugin ID: ${plugin.id}`)
    if (seen.has(plugin.id)) throw new Error(`Duplicate DSH plugin ID: ${plugin.id}`)
    seen.add(plugin.id)
    const lines = [
      `    - id: ${yamlString(plugin.id)}`,
      `      name: ${yamlString(pathToFileURL(plugin.modulePath).href)}`,
    ]
    if (Object.keys(plugin.config).length > 0) {
      lines.push('      config:', ...yamlMapLines(plugin.config, 8))
    }
    return lines
  })
}

function yamlMapLines(value: Record<string, unknown>, indentation: number): string[] {
  return Object.entries(value).flatMap(([key, child]) => yamlEntryLines(key, child, indentation))
}

function yamlEntryLines(key: string, value: unknown, indentation: number): string[] {
  const prefix = ' '.repeat(indentation)
  const property = `${prefix}${yamlString(key)}:`
  if (isRecord(value)) {
    const entries = Object.entries(value)
    return entries.length === 0 ? [`${property} {}`] : [property, ...yamlMapLines(value, indentation + 2)]
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? [`${property} []`]
      : [property, ...value.flatMap((item) => yamlSequenceLines(item, indentation + 2))]
  }
  return [`${property} ${yamlScalar(value)}`]
}

function yamlSequenceLines(value: unknown, indentation: number): string[] {
  const prefix = ' '.repeat(indentation)
  if (isRecord(value)) {
    const entries = Object.entries(value)
    return entries.length === 0 ? [`${prefix}- {}`] : [`${prefix}-`, ...yamlMapLines(value, indentation + 2)]
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? [`${prefix}- []`]
      : [`${prefix}-`, ...value.flatMap((item) => yamlSequenceLines(item, indentation + 2))]
  }
  return [`${prefix}- ${yamlScalar(value)}`]
}

function yamlScalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return yamlString(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new Error('DSH plugin configuration must contain only JSON values.')
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}
