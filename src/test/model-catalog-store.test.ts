import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { registerHooks } from 'node:module'
import type { SavedModel } from '../runtime/model-catalog.js'

// Isolated VS Code API fixture: workspace.fs is backed by a real temp directory.
const storageRoot = join(tmpdir(), `helix-model-catalog-${process.pid}`)
await mkdir(storageRoot, { recursive: true })
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
        export const Uri = { joinPath: (uri, name) => ({ fsPath: uri.fsPath + '/' + name }) };
        export const workspace = {
          workspaceFolders: [],
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
          getConfiguration: (prefix) => ({ get: (key, fallback) => values.get(prefix ? prefix + '.' + key : key) ?? fallback }),
        };
      `,
    }
  },
})
const {
  REASONING_HISTORY_KEY,
  readModelCatalogFile,
  reasoningEffortHistory,
  rememberModelReasoningEffort,
  resolveModelReasoningEffort,
  writeModelCatalogFile,
} = await import('../host/model-catalog-store.js')
const vscode = await import('vscode') as unknown as { values: Map<string, unknown> }

interface Context {
  globalStorageUri: { fsPath: string }
  globalState: { get: (key: string, fallback?: unknown) => unknown; update: (key: string, value: unknown) => Promise<boolean> }
  state: Map<string, unknown>
}

function context(storageDir: string): Context {
  const state = new Map<string, unknown>()
  return {
    globalStorageUri: { fsPath: storageDir },
    globalState: {
      get: (key, fallback) => state.has(key) ? state.get(key) : fallback,
      update: async (key, value) => { state.set(key, value); return true },
    },
    state,
  }
}

async function writeCatalogFile(storageDir: string, contents: string): Promise<void> {
  await writeFile(join(storageDir, 'models.json'), contents, 'utf8')
}

test('readModelCatalogFile returns an empty list when the file is missing', async () => {
  const storage = join(storageRoot, 'missing')
  await mkdir(storage, { recursive: true })
  try {
    assert.deepEqual(await readModelCatalogFile(context(storage) as never), [])
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('the catalog round-trips through writeModelCatalogFile', async () => {
  const storage = join(storageRoot, 'roundtrip')
  const models: SavedModel[] = [
    { id: 'model-a', displayName: 'Model A', contextWindow: 123456, reasoningEfforts: ['low', 'medium', 'high'], systemInstructions: 'be brief' },
    { id: 'model-b' },
  ]
  try {
    const ctx = context(storage)
    await writeModelCatalogFile(ctx as never, models)
    const read = await readModelCatalogFile(ctx as never)
    assert.deepEqual(read, models)
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('a legacy file is migrated in place and seeds the effort history', async () => {
  const storage = join(storageRoot, 'legacy')
  await mkdir(storage, { recursive: true })
  const legacy = {
    version: 1,
    models: [
      { id: 'model-a', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
      { id: 'model-b', reasoningEfforts: ['low'] },
    ],
  }
  try {
    await writeCatalogFile(storage, JSON.stringify(legacy))
    const ctx = context(storage)

    const models = await readModelCatalogFile(ctx as never)
    assert.equal(models.length, 2)
    assert.equal(models[0].id, 'model-a')

    const rewritten = JSON.parse(await readFile(join(storage, 'models.json'), 'utf8'))
    assert.equal(rewritten.models[0].defaultReasoningEffort, undefined, 'the legacy field is rewritten away')
    assert.deepEqual(ctx.state.get(REASONING_HISTORY_KEY), { 'model-a': 'high' }, 'the legacy default seeds the history')

    // The second read is already clean: no further state writes.
    const sizeBefore = ctx.state.size
    await readModelCatalogFile(ctx as never)
    assert.equal(ctx.state.size, sizeBefore)
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('an unreadable catalog file surfaces the JSON error', async () => {
  const storage = join(storageRoot, 'corrupt')
  await mkdir(storage, { recursive: true })
  try {
    await writeCatalogFile(storage, '{ not json')
    await assert.rejects(readModelCatalogFile(context(storage) as never), /invalid JSON/)
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('reasoningEffortHistory drops empty keys and values', async () => {
  const storage = join(storageRoot, 'history')
  const ctx = context(storage)
  ctx.state.set(REASONING_HISTORY_KEY, { 'model-a': 'high', '': 'x', 'model-b': '  ', 'model-c': 42, 'model-d': 'low' })
  assert.deepEqual(reasoningEffortHistory(ctx as never), { 'model-a': 'high', 'model-d': 'low' })

  ctx.state.delete(REASONING_HISTORY_KEY)
  assert.deepEqual(reasoningEffortHistory(ctx as never), {})
  await rm(storage, { recursive: true, force: true })
})

test('rememberModelReasoningEffort stores only selectable efforts', async () => {
  const storage = join(storageRoot, 'remember')
  const ctx = context(storage)
  const models: SavedModel[] = [{ id: 'model-a', reasoningEfforts: ['low', 'high'] }]
  await writeModelCatalogFile(ctx as never, models)
  try {
    await rememberModelReasoningEffort(ctx as never, 'model-a', 'high')
    assert.deepEqual(ctx.state.get(REASONING_HISTORY_KEY), { 'model-a': 'high' })

    await rememberModelReasoningEffort(ctx as never, 'model-a', 'high')
    await rememberModelReasoningEffort(ctx as never, 'model-a', 'medium')
    await rememberModelReasoningEffort(ctx as never, 'unknown-model', 'high')
    await rememberModelReasoningEffort(ctx as never, 'model-a', undefined)
    assert.deepEqual(ctx.state.get(REASONING_HISTORY_KEY), { 'model-a': 'high' }, 'unselectable, unknown, and undefined efforts are no-ops')
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('resolveModelReasoningEffort prefers the last used selectable effort', async () => {
  const storage = join(storageRoot, 'resolve')
  const ctx = context(storage)
  const models: SavedModel[] = [
    { id: 'model-a', reasoningEfforts: ['low', 'medium', 'high'] },
    { id: 'model-b', reasoningEfforts: ['low'], binaryThinkingMode: 'on' },
  ]
  await writeModelCatalogFile(ctx as never, models)
  try {
    await rememberModelReasoningEffort(ctx as never, 'model-a', 'medium')

    assert.equal(await resolveModelReasoningEffort(ctx as never, null, 'model-a'), 'medium', 'the remembered effort wins')
    assert.equal(await resolveModelReasoningEffort(ctx as never, 'high', 'model-a'), 'high', 'an explicit selection wins')
    await assert.rejects(resolveModelReasoningEffort(ctx as never, 'unknown', 'model-a'), /not configured/)
    assert.equal(await resolveModelReasoningEffort(ctx as never, null, 'model-b'), 'low', 'binary formats resolve their thinking level')
    assert.equal(await resolveModelReasoningEffort(ctx as never, null, 'no-such-model'), undefined)
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})
