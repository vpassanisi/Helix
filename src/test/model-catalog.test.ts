import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeSelectionAfterCatalogSave,
  modelEndpointCandidates,
  normalizeModelDrafts,
  parseModelCatalog,
  parseSavedModelCatalogJson,
  piAiRuntimeModelProfiles,
  selectableReasoningEfforts,
  resolveSavedModelReasoningEffort,
  selectionForSavedModel,
  serializeSavedModelCatalog,
  updateReasoningEffortSelection,
  validateModelDraftSources,
  type ModelDraft,
  type SavedModel,
} from '../runtime/model-catalog.js'

test('parses OpenAI model lists and provider context metadata', () => {
  const models = parseModelCatalog({
    object: 'list',
    data: [
      {
        id: 'unsloth/gpt-oss-20b-GGUF',
        object: 'model',
        created: 1788901638,
        owned_by: 'unsloth-studio',
        context_length: 131072,
        max_context_length: 131072,
        native_context_length: 131072,
        loaded: true,
      },
      {
        id: 'krea/Krea-2-Turbo',
        object: 'model',
        task: 'text-to-image',
      },
    ],
  })

  assert.deepEqual(models, [{
    id: 'unsloth/gpt-oss-20b-GGUF',
    contextWindow: 131072,
    loaded: true,
  }])
})

test('tries OpenAI base and /v1 model endpoints', () => {
  assert.deepEqual(modelEndpointCandidates('http://localhost:1234/v1'), [
    'http://localhost:1234/v1/models',
  ])
  assert.deepEqual(modelEndpointCandidates('http://localhost:1234'), [
    'http://localhost:1234/models',
    'http://localhost:1234/v1/models',
  ])
})

test('loads an empty saved catalog and round-trips editable model metadata', () => {
  assert.deepEqual(parseSavedModelCatalogJson('{"version":1,"models":[]}'), [])

  const models: SavedModel[] = [{
    id: 'provider/model-a',
    displayName: 'Model A',
    contextWindow: 65536,
  }]
  const serialized = serializeSavedModelCatalog(models)

  assert.match(serialized, /"version": 1/)
  assert.deepEqual(parseSavedModelCatalogJson(serialized), models)
})

test('loads legacy models without effort metadata and round-trips model-specific effort choices', () => {
  assert.deepEqual(parseSavedModelCatalogJson('{"version":1,"models":[{"id":"legacy"}]}'), [{ id: 'legacy' }])
  assert.deepEqual(piAiRuntimeModelProfiles(parseSavedModelCatalogJson('{"version":1,"models":[{"id":"legacy"}]}'))[0].input, ['text'])
  const models: SavedModel[] = [{
    id: 'provider/model-a',
    reasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high',
  }]
  assert.deepEqual(parseSavedModelCatalogJson(serializeSavedModelCatalog(models)), models)
})

test('saves Vision on and off, and rejects non-boolean values', () => {
  const models: SavedModel[] = [
    { id: 'vision-on', acceptsImages: true },
    { id: 'vision-off', acceptsImages: false },
  ]
  const serialized = serializeSavedModelCatalog(models)
  assert.match(serialized, /"version": 1/)
  assert.deepEqual(parseSavedModelCatalogJson(serialized), models)
  assert.deepEqual(piAiRuntimeModelProfiles(models).map((model) => model.input), [['text', 'image'], ['text']])
  assert.throws(() => parseSavedModelCatalogJson('{"version":1,"models":[{"id":"invalid","acceptsImages":"true"}]}'), /invalid Vision setting/)
})

test('round-trips per-model selected reasoning levels, format, binary mode, and template values', () => {
  const models: SavedModel[] = [
    {
      id: 'chat-template-model',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium',
      reasoningFormat: 'chat-template',
      chatTemplateKwargs: {
        enable_thinking: { $var: 'thinking.enabled', omitWhenOff: true },
        budget: { $var: 'thinking.budget' },
        top_k: 4,
        add_generation_prompt: true,
        template: 'standard',
        unset: null,
      },
    },
    {
      id: 'qwen-model',
      reasoningFormat: 'qwen-chat-template',
      binaryThinkingMode: 'on',
    },
    {
      id: 'baseten-model',
      reasoningEfforts: ['low', 'medium', 'high'],
      reasoningFormat: 'baseten',
      chatTemplateArgs: { effort: { $var: 'thinking.effort' } },
    },
  ]
  assert.deepEqual(parseSavedModelCatalogJson(serializeSavedModelCatalog(models)), models)
})

test('validates reasoning formats, selected levels, and supported template variables', () => {
  assert.throws(() => serializeSavedModelCatalog([{ id: 'bad', reasoningFormat: 'unknown' }]), /unsupported reasoning format/)
  assert.throws(() => serializeSavedModelCatalog([{ id: 'bad', reasoningFormat: 'deepseek', reasoningEfforts: ['custom'] }]), /needs a supported reasoning effort/)
  assert.throws(() => serializeSavedModelCatalog([{ id: 'bad', reasoningEfforts: ['off'] }]), /at least one graded reasoning effort/)
  assert.throws(() => parseSavedModelCatalogJson('{"version":1,"models":[{"id":"bad","reasoningPreset":"custom"}]}'), /unsupported reasoning effort preset/)
  assert.deepEqual(parseSavedModelCatalogJson('{"version":1,"models":[{"id":"provider-default","reasoningFormat":"deepseek","reasoningEfforts":[]}]}'), [
    { id: 'provider-default', reasoningEfforts: [], reasoningFormat: 'deepseek' },
  ])
  assert.throws(() => serializeSavedModelCatalog([{ id: 'bad', chatTemplateKwargs: [] }]), /must be a JSON object/)
  assert.throws(() => serializeSavedModelCatalog([{ id: 'bad', chatTemplateKwargs: { effort: { $var: 'thinking.secret' } } }]), /supported DSH \$var/)
  assert.throws(() => serializeSavedModelCatalog([{ id: 'bad', chatTemplateArgs: { effort: { $var: 'thinking.effort', extra: true } } }]), /supported DSH \$var/)
})

test('migrates legacy presets to individual levels and writes catalogs without the preset field', () => {
  const presetOnly = parseSavedModelCatalogJson('{"version":1,"models":[{"id":"preset-only","reasoningPreset":"low-medium-high-xhigh","defaultReasoningEffort":"medium"}]}')
  assert.deepEqual(presetOnly, [{
    id: 'preset-only',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  }])

  const savedListWins = parseSavedModelCatalogJson('{"version":1,"models":[{"id":"saved-list","reasoningPreset":"all-levels","reasoningEfforts":["low","max"]}]}')
  assert.deepEqual(savedListWins, [{ id: 'saved-list', reasoningEfforts: ['low', 'max'] }])
  const serialized = serializeSavedModelCatalog(presetOnly)
  assert.doesNotMatch(serialized, /reasoningPreset/)
  assert.deepEqual(parseSavedModelCatalogJson(serialized), presetOnly)
})

test('individual effort selection supports subsets, clears defaults, and treats empty as provider default', () => {
  assert.deepEqual(updateReasoningEffortSelection(['low', 'medium', 'high'], 'medium', 'medium', false), {
    reasoningEfforts: ['low', 'high'],
  })
  assert.deepEqual(updateReasoningEffortSelection(['low'], 'low', 'low', false), {
    reasoningEfforts: [],
  })
  assert.deepEqual(updateReasoningEffortSelection(['high'], 'high', 'low', true), {
    reasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high',
  })
})

test('empty effort configuration omits the composer selector and lets the provider choose', () => {
  const model: SavedModel = { id: 'provider-default', reasoningEfforts: [], reasoningFormat: 'openai' }
  assert.deepEqual(selectableReasoningEfforts(model), [])
  assert.equal(resolveSavedModelReasoningEffort([model], model.id, null), undefined)
  assert.deepEqual(piAiRuntimeModelProfiles([model]), [{ id: model.id, input: ['text'], compat: { thinkingFormat: 'openai' } }])
})

test('off can only be selected with a graded level and is cleared when the last graded level is removed', () => {
  assert.equal(updateReasoningEffortSelection([], undefined, 'off', true), undefined)
  assert.deepEqual(updateReasoningEffortSelection(['low'], 'low', 'off', true), {
    reasoningEfforts: ['off', 'low'],
    defaultReasoningEffort: 'low',
  })
  assert.deepEqual(updateReasoningEffortSelection(['off', 'low'], 'low', 'low', false), {
    reasoningEfforts: [],
  })
  assert.throws(() => serializeSavedModelCatalog([{ id: 'off-only', reasoningEfforts: ['off'] }]), /at least one graded reasoning effort/)
})

test('keeps nonstandard saved effort IDs as legacy entries while updating standard levels', () => {
  assert.deepEqual(updateReasoningEffortSelection(['provider_custom', 'low'], 'provider_custom', 'low', false), {
    reasoningEfforts: ['provider_custom'],
    defaultReasoningEffort: 'provider_custom',
  })
  assert.equal(updateReasoningEffortSelection([], undefined, 'provider_custom', true), undefined)
})

test('generates identity DSH effort maps, per-model format settings, and binary composer behavior', () => {
  const models: SavedModel[] = [
    {
      id: 'graded',
      reasoningEfforts: ['off', 'low', 'high'],
      reasoningFormat: 'deepseek',
      contextWindow: 8192,
    },
    { id: 'auto', reasoningEfforts: ['low', 'high'] },
    { id: 'qwen-on', reasoningFormat: 'qwen', binaryThinkingMode: 'on' },
    { id: 'qwen-off', reasoningFormat: 'qwen-chat-template', binaryThinkingMode: 'off' },
    { id: 'qwen-default', reasoningFormat: 'qwen', binaryThinkingMode: 'provider-default' },
  ]
  const profiles = piAiRuntimeModelProfiles(models)
  assert.deepEqual(profiles[0], {
    id: 'graded',
    input: ['text'],
    contextWindow: 8192,
    reasoningEfforts: { off: null, low: 'low', high: 'high' },
    compat: { thinkingFormat: 'deepseek' },
  })
  assert.deepEqual(profiles[1], { id: 'auto', input: ['text'], reasoningEfforts: { low: 'low', high: 'high' } })
  assert.deepEqual(profiles[2], {
    id: 'qwen-on',
    input: ['text'],
    reasoningEfforts: { low: 'low' },
    compat: { thinkingFormat: 'qwen', supportsReasoningEffort: false },
  })
  assert.deepEqual(profiles[3], {
    id: 'qwen-off',
    input: ['text'],
    reasoningEfforts: { low: 'low', off: null },
    compat: { thinkingFormat: 'qwen-chat-template' },
  })
  assert.deepEqual(profiles[4], {
    id: 'qwen-default',
    input: ['text'],
    reasoningEfforts: false,
    compat: { thinkingFormat: 'qwen', supportsReasoningEffort: false },
  })
  assert.deepEqual(selectableReasoningEfforts(models[0]), ['off', 'low', 'high'])
  assert.deepEqual(selectableReasoningEfforts(models[2]), [])
})

test('rejects malformed JSON, unsupported versions, duplicate IDs, and invalid context windows', () => {
  assert.throws(() => parseSavedModelCatalogJson('{'), /invalid JSON/i)
  assert.throws(() => parseSavedModelCatalogJson('{"version":2,"models":[]}'), /version 1/)
  assert.throws(() => serializeSavedModelCatalog([
    { id: 'model-a' },
    { id: ' model-a ' },
  ]), /duplicated/)
  assert.throws(() => serializeSavedModelCatalog([{ id: 'model-a', contextWindow: 0 }]), /positive whole-number/)
})

test('rejects invalid effort IDs and defaults that are not configured', () => {
  assert.throws(() => serializeSavedModelCatalog([{ id: 'model-a', reasoningEfforts: ['low', ' low '] }]), /duplicate reasoning effort/)
  assert.throws(() => serializeSavedModelCatalog([{ id: 'model-a', reasoningEfforts: ['  '] }]), /empty or invalid reasoning effort/)
  assert.throws(() => serializeSavedModelCatalog([{ id: 'model-a', defaultReasoningEffort: 'high' }]), /must be one of its configured effort IDs/)
  assert.throws(() => serializeSavedModelCatalog([{ id: 'model-a', reasoningEfforts: ['low'], defaultReasoningEffort: 'high' }]), /must be one of its configured effort IDs/)
})

test('resolves a model default and validates explicit effort selections', () => {
  const models: SavedModel[] = [{
    id: 'model-a',
    reasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high',
  }]
  assert.equal(resolveSavedModelReasoningEffort(models, 'model-a', null), 'high')
  assert.equal(resolveSavedModelReasoningEffort(models, 'model-a', 'low'), 'low')
  assert.equal(resolveSavedModelReasoningEffort([{ id: 'model-b' }], 'model-b', null), undefined)
  assert.throws(() => resolveSavedModelReasoningEffort(models, 'model-a', 'max'), /not configured/)
})

test('resolves a fixed binary model-card mode without exposing graded effort choices', () => {
  const models: SavedModel[] = [
    { id: 'on', reasoningFormat: 'qwen', binaryThinkingMode: 'on' },
    { id: 'off', reasoningFormat: 'qwen-chat-template', binaryThinkingMode: 'off' },
    { id: 'default', reasoningFormat: 'qwen', binaryThinkingMode: 'provider-default' },
  ]
  assert.equal(resolveSavedModelReasoningEffort(models, 'on', null), 'low')
  assert.equal(resolveSavedModelReasoningEffort(models, 'off', null), 'off')
  assert.equal(resolveSavedModelReasoningEffort(models, 'default', null), undefined)
  assert.deepEqual(selectableReasoningEfforts(models[0]), [])
})

test('catalog import preserves editable endpoint metadata and omits transient fields when saved', () => {
  const discovered = parseModelCatalog({
    data: [{ id: 'model-a', display_name: 'Model A', native_context_length: 32768, loaded: true }],
  })
  const serialized = serializeSavedModelCatalog(discovered)

  assert.deepEqual(parseSavedModelCatalogJson(serialized), [{
    id: 'model-a',
    displayName: 'Model A',
    contextWindow: 32768,
  }])
})

test('renaming the active saved model keeps it selected and applies edited context', () => {
  const previous: SavedModel[] = [{ id: 'old-id', contextWindow: 32768 }]
  const next: ModelDraft[] = [{ id: 'new-id', contextWindow: 65536, sourceId: 'old-id' }]

  assert.deepEqual(activeSelectionAfterCatalogSave(previous, next, {
    model: 'old-id',
    contextWindow: 32768,
  }), { model: 'new-id', contextWindow: 65536 })
})

test('deleting the active saved model selects the first remaining model', () => {
  const previous: SavedModel[] = [{ id: 'active' }, { id: 'other', contextWindow: 8192 }]
  const next: ModelDraft[] = [{ id: 'other', contextWindow: 8192, sourceId: 'other' }]

  assert.deepEqual(activeSelectionAfterCatalogSave(previous, next, {
    model: 'active',
    contextWindow: 0,
  }), { model: 'other', contextWindow: 8192 })
})

test('selecting a saved model resolves its persisted ID and context window', () => {
  assert.deepEqual(selectionForSavedModel([
    { id: 'model-a' },
    { id: 'model-b', contextWindow: 24576 },
  ], 'model-b'), { model: 'model-b', contextWindow: 24576 })
  assert.throws(() => selectionForSavedModel([], 'missing'), /not in the saved models catalog/)
})

test('catalog edits retain unique source identities and reject stale entries', () => {
  const previous = [{ id: 'old-id' }]
  const renamed = normalizeModelDrafts([{ id: 'new-id', sourceId: 'old-id' }])
  assert.doesNotThrow(() => validateModelDraftSources(previous, renamed))
  assert.throws(() => validateModelDraftSources(previous, normalizeModelDrafts([
    { id: 'new-id', sourceId: 'old-id' },
    { id: 'another-id', sourceId: 'old-id' },
  ])), /appears more than once/)
  assert.throws(() => validateModelDraftSources(previous, normalizeModelDrafts([
    { id: 'renamed', sourceId: 'stale-id' },
  ])), /changed since the catalog was loaded/)
})

test('an empty catalog or an unmigrated active model leaves the runtime selection alone', () => {
  assert.equal(activeSelectionAfterCatalogSave([{ id: 'active' }], [], {
    model: 'active',
    contextWindow: 0,
  }), undefined)
  assert.equal(activeSelectionAfterCatalogSave([], [{ id: 'new' }], {
    model: 'legacy-setting',
    contextWindow: 0,
  }), undefined)
})

test('adding the currently active legacy model applies its saved context without switching IDs', () => {
  assert.deepEqual(activeSelectionAfterCatalogSave([], [{
    id: 'legacy-setting',
    contextWindow: 32768,
  }], {
    model: 'legacy-setting',
    contextWindow: 0,
  }), { model: 'legacy-setting', contextWindow: 32768 })
})
