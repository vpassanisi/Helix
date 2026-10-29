import * as vscode from 'vscode'
import {
  parseSavedModelCatalogJsonWithLegacy,
  resolveSavedModelReasoningEffort,
  seedReasoningEffortHistory,
  selectableReasoningEfforts,
  serializeSavedModelCatalog,
  type SavedModel,
} from '../runtime/model-catalog.js'
import { isRecord } from '../shared/value-utils.js'

export const MODEL_CATALOG_FILE = 'models.json'
export const REASONING_HISTORY_KEY = 'helix.lastUsedReasoningEfforts'

/**
 * The saved model catalog, with the last-used reasoning-effort history. A
 * file in the pre-history legacy shape is migrated in place so the next read
 * is already clean.
 */
export async function readModelCatalogFile(context: vscode.ExtensionContext): Promise<SavedModel[]> {
  const uri = vscode.Uri.joinPath(context.globalStorageUri, MODEL_CATALOG_FILE)
  let contents: Uint8Array
  try {
    contents = await vscode.workspace.fs.readFile(uri)
  } catch (error) {
    if (isFileNotFoundError(error)) return []
    throw error
  }

  const { models, legacyDefaults, needsMigration } = parseSavedModelCatalogJsonWithLegacy(new TextDecoder().decode(contents))
  if (needsMigration) {
    const history = reasoningEffortHistory(context)
    const migrated = seedReasoningEffortHistory(history, legacyDefaults)
    if (JSON.stringify(history) !== JSON.stringify(migrated)) {
      await context.globalState.update(REASONING_HISTORY_KEY, migrated)
    }
    await writeModelCatalogFile(context, models)
  }
  return models
}

export async function writeModelCatalogFile(context: vscode.ExtensionContext, models: SavedModel[]): Promise<void> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri)
  const uri = vscode.Uri.joinPath(context.globalStorageUri, MODEL_CATALOG_FILE)
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeSavedModelCatalog(models)))
}

export function reasoningEffortHistory(context: vscode.ExtensionContext): Record<string, string> {
  const stored = context.globalState.get<unknown>(REASONING_HISTORY_KEY)
  if (!isRecord(stored)) return {}
  return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] =>
    entry[0] !== '' && typeof entry[1] === 'string' && entry[1].trim() !== ''))
}

export async function resolveModelReasoningEffort(
  context: vscode.ExtensionContext,
  selection: string | null,
  modelId = vscode.workspace.getConfiguration('deepseekHarness').get<string>('model', 'deepseek-flash'),
): Promise<string | undefined> {
  const models = await readModelCatalogFile(context)
  return resolveSavedModelReasoningEffort(models, modelId, selection, reasoningEffortHistory(context)[modelId])
}

export async function rememberModelReasoningEffort(
  context: vscode.ExtensionContext,
  modelId: string,
  effort: string | undefined,
): Promise<void> {
  if (effort === undefined) return
  const models = await readModelCatalogFile(context)
  const model = models.find((entry) => entry.id === modelId)
  if (!selectableReasoningEfforts(model).includes(effort)) return
  const history = reasoningEffortHistory(context)
  if (history[modelId] === effort) return
  await context.globalState.update(REASONING_HISTORY_KEY, { ...history, [modelId]: effort })
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'FileNotFound'
}
