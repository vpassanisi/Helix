import assert from 'node:assert/strict'
import test from 'node:test'
import {
  configuredPluginBundles,
  createOtelTracingPlugin,
  pluginPatchLines,
} from '../runtime/plugins.js'

test('createOtelTracingPlugin points at the bundled plugin and normalizes config', () => {
  const plugin = createOtelTracingPlugin('/ext', { enabled: true, serviceName: 'helix' })
  assert.equal(plugin.id, 'dsh-otel-tracing')
  assert.equal(plugin.modulePath, '/ext/out/plugins/dsh-otel-plugin/index.mjs')
  assert.deepEqual(plugin.config, { enabled: true, serviceName: 'helix' })

  assert.deepEqual(createOtelTracingPlugin('/ext', 'broken').config, {}, 'a non-object config falls back to an empty one')
})

test('configuredPluginBundles keeps only enabled, well-formed entries', () => {
  const bundles = configuredPluginBundles([
    { id: 'my-plugin', path: '/abs/bundle.mjs', enabled: true, config: { a: 1 } },
    { id: 'off-plugin', path: '/abs/off.mjs', enabled: false },
    'not-a-record',
  ], '/ext')
  assert.equal(bundles.length, 1)
  assert.equal(bundles[0].id, 'my-plugin')
  assert.equal(bundles[0].modulePath, '/abs/bundle.mjs')
  assert.deepEqual(bundles[0].config, { a: 1 })
})

test('configuredPluginBundles resolves relative paths against the extension root', () => {
  const bundles = configuredPluginBundles([
    { id: 'relative', path: 'out/plugins/other/index.mjs', enabled: true },
  ], '/ext')
  assert.equal(bundles[0].modulePath, '/ext/out/plugins/other/index.mjs')
  assert.deepEqual(bundles[0].config, {})
})

test('configuredPluginBundles rejects invalid ids, missing paths, and bad config', () => {
  assert.throws(
    () => configuredPluginBundles([{ id: 'Has Caps', path: '/x.mjs', enabled: true }], '/ext'),
    /needs a lowercase plugin ID/,
  )
  assert.throws(
    () => configuredPluginBundles([{ id: 'no-path', enabled: true }], '/ext'),
    /needs a local bundle path/,
  )
  assert.throws(
    () => configuredPluginBundles([{ id: 'bad-config', path: '/x.mjs', enabled: true, config: 'nope' }], '/ext'),
    /must be an object/,
  )
  assert.deepEqual(configuredPluginBundles('not-an-array', '/ext'), [])
})

test('pluginPatchLines emits the DSH plugin YAML with config', () => {
  const lines = pluginPatchLines([
    { id: 'my-plugin', modulePath: '/abs/bundle.mjs', config: { key: 'value', nested: { inner: true }, list: ['a'] } },
    { id: 'bare', modulePath: '/abs/bare.mjs', config: {} },
  ])
  assert.deepEqual(lines, [
    '    - id: "my-plugin"',
    `      name: ${JSON.stringify('file:///abs/bundle.mjs')}`,
    '      config:',
    '        "key": "value"',
    '        "nested":',
    '          "inner": true',
    '        "list":',
    '          - "a"',
    '    - id: "bare"',
    `      name: ${JSON.stringify('file:///abs/bare.mjs')}`,
  ])
})

test('pluginPatchLines rejects invalid and duplicate ids', () => {
  assert.throws(() => pluginPatchLines([{ id: 'Has Caps', modulePath: '/x.mjs', config: {} }]), /Invalid DSH plugin ID/)
  assert.throws(
    () => pluginPatchLines([
      { id: 'dup', modulePath: '/a.mjs', config: {} },
      { id: 'dup', modulePath: '/b.mjs', config: {} },
    ]),
    /Duplicate DSH plugin ID/,
  )
})
