import assert from 'node:assert/strict'
import test from 'node:test'
import { modelEndpointCandidates, parseModelCatalog } from '../runtime/model-catalog.js'

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
