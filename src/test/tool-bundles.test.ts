import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TOOL_BUNDLE_OPTIONS,
  disabledToolNames,
  enabledToolNames,
  normalizeDisabledToolBundles,
  toolBundleLabel,
  toolBundlePatchLines,
} from '../shared/tool-bundles.js'

test('tool bundle options are unique, labelled, and list their tools', () => {
  const ids = TOOL_BUNDLE_OPTIONS.map((option) => option.id)
  assert.equal(new Set(ids).size, ids.length, 'bundle ids must be unique')
  for (const option of TOOL_BUNDLE_OPTIONS) {
    assert.ok(option.label.trim().length > 0, `${option.id} needs a label`)
    assert.ok(option.tools.length > 0, `${option.id} needs at least one tool`)
    assert.ok(option.hint.trim().length > 0, `${option.id} needs a hint`)
  }
})

test('normalization keeps known ids, dedupes, and sorts for a stable patch', () => {
  assert.deepEqual(
    normalizeDisabledToolBundles(['tool-workflow', 'tool-fs', 'tool-workflow', 'made-up', 7, undefined]),
    ['tool-fs', 'tool-workflow'],
  )
  assert.deepEqual(normalizeDisabledToolBundles(undefined), [])
  assert.deepEqual(normalizeDisabledToolBundles('tool-fs'), [])
})

test('a bundle Helix locks off cannot be carried by the saved list', () => {
  assert.deepEqual(normalizeDisabledToolBundles(['tool-web', 'tool-fs']), ['tool-fs'])
})

test('patch lines disable exactly the normalised bundles', () => {
  assert.deepEqual(toolBundlePatchLines(['tool-subagent-fork', 'tool-bash']), [
    '- id: "tool-bash"',
    '  disabled: true',
    '- id: "tool-subagent-fork"',
    '  disabled: true',
  ])
  assert.deepEqual(toolBundlePatchLines([]), [])
})

test('enabled and disabled tool names split without overlap', () => {
  const disabled = ['tool-fs-search', 'tool-subagent']
  const off = disabledToolNames(disabled)
  const on = enabledToolNames(disabled)
  assert.deepEqual(off, ['glob', 'grep', 'subagent'])
  assert.ok(on.includes('read') && on.includes('subagent_fork'))
  assert.ok(!on.includes('grep'))
  assert.ok(!on.includes('subagent'))
})

test('labels fall back to the id for unknown bundles', () => {
  assert.equal(toolBundleLabel('tool-fs'), 'File tools')
  assert.equal(toolBundleLabel('not-a-bundle'), 'not-a-bundle')
})
