import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequestPreviewView } from '../shared/request-preview-view.js'
import type { RequestPreviewResult } from '../runtime/control-protocol.js'

test('builds ordered prompt cards from DSH system sections and runtime context without duplicating snapshots', () => {
  const preview: RequestPreviewResult = {
    request: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'Harness identity.\n\nSkill catalog.' }],
          source: { kind: 'plugin', plugin: 'dsh-system-prompt' },
        },
        { role: 'user', content: [{ type: 'text', text: 'Check release notes.' }], source: { kind: 'user' } },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Current runtime context.\n\nWorkspace is Helix.' }],
          source: {
            kind: 'plugin',
            plugin: 'dsh-agent-runtime-context',
            form: 'snapshot',
            sections: [{ name: 'workspace:state', text: 'Workspace is Helix.' }],
          },
        },
      ],
      tools: [{ name: 'mcp__docs__search', description: 'Search documentation', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxTokens: 2048,
      stop: ['<END>'],
    },
    promptBreakdown: {
      systemSections: [
        { name: 'harness:identity', text: 'Harness identity.' },
        { name: 'skills:catalog', text: 'Skill catalog.' },
      ],
      contextSections: [{ name: 'workspace:state', text: 'Workspace is Helix.' }],
    },
  }

  const view = createRequestPreviewView(preview)
  assert.equal(view.provider, 'deepseek-official')
  assert.equal(view.model, 'deepseek-v4-flash')
  assert.deepEqual(view.promptItems.map(({ role }) => role), ['system', 'user', 'user'])
  assert.deepEqual(view.promptItems[0]?.sections, preview.promptBreakdown?.systemSections)
  assert.equal(view.promptItems[1]?.text, 'Check release notes.')
  assert.deepEqual(view.promptItems[2]?.sections, preview.promptBreakdown?.contextSections)
  assert.equal(view.promptItems[2]?.text, undefined, 'the flattened snapshot is replaced by its named source sections')
  assert.equal(view.promptItems[2]?.source, 'dsh-agent-runtime-context')
  assert.deepEqual(view.details, [
    { label: 'Reasoning effort', value: 'Provider controlled' },
    { label: 'Temperature', value: '0.2' },
    { label: 'Max tokens', value: '2048' },
    { label: 'Stop sequences', value: '<END>' },
  ])
  assert.deepEqual(view.tools, [{
    name: 'mcp__docs__search',
    description: 'Search documentation',
    parameters: { type: 'object' },
  }])
})

test('falls back to captured prompt text when DSH provenance is unavailable', () => {
  const preview: RequestPreviewResult = {
    request: {
      provider: 'route',
      model: 'model',
      system: 'Separate system input.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'First block.' }, { type: 'image', url: 'image-ref' }] },
      ],
    },
  }

  const view = createRequestPreviewView(preview)
  assert.deepEqual(view.promptItems.map((item) => [item.role, item.text]), [
    ['system', 'Separate system input.'],
    ['user', 'First block.\n\n[image block]\n{\n  "type": "image",\n  "url": "image-ref"\n}'],
  ])
  assert.deepEqual(view.tools, [])
  assert.equal(view.details[0]?.value, 'Provider controlled')
})

test('uses named DSH sections for a top-level system prompt only when their rendered text matches', () => {
  const preview: RequestPreviewResult = {
    request: { provider: 'route', model: 'model', system: 'Actual system prompt.', messages: [] },
    promptBreakdown: {
      systemSections: [{ name: 'deployment:persona-prefix', text: 'Different prompt.' }],
      contextSections: [],
    },
  }

  const view = createRequestPreviewView(preview)
  assert.deepEqual(view.promptItems, [{ role: 'system', text: 'Actual system prompt.' }])
})
