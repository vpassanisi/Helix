import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalRenderedElement, draftKey, draftRuns, editorRuns, serializeRuns } from '../webview/lib/composer-document.js'
import type { ComposerCommand } from '../shared/commands.js'

const catalog: ComposerCommand[] = [
  { name: 'compact', description: 'Compact older conversation history' },
  { name: 'goal', description: 'Create, pause, resume, or complete the session goal', hint: '[action]' },
]

test('the leading token that names a command is its own run', () => {
  assert.deepEqual(draftRuns('/compact the older history', catalog), [
    { kind: 'command', text: '/compact', command: catalog[0]! },
    { kind: 'text', text: ' the older history' },
  ])
  assert.deepEqual(draftRuns('/compact', catalog), [{ kind: 'command', text: '/compact', command: catalog[0]! }])
  assert.deepEqual(draftRuns('/goal pause', catalog), [
    { kind: 'command', text: '/goal', command: catalog[1]! },
    { kind: 'text', text: ' pause' },
  ])
})

test('a token that is not a command, and a token that is not leading, stay plain text', () => {
  assert.deepEqual(draftRuns('/comp', catalog), [{ kind: 'text', text: '/comp' }])
  assert.deepEqual(draftRuns('run /compact now', catalog), [{ kind: 'text', text: 'run /compact now' }])
  assert.deepEqual(draftRuns('', catalog), [{ kind: 'text', text: '' }])
})

test('the runs serialise back to the line the composer sends', () => {
  for (const text of ['/compact', '/goal pause', '/comp', 'plain /compact', '/compact\nsecond line']) {
    assert.equal(serializeRuns(draftRuns(text, catalog)), text)
  }
})

test('editor runs merge adjacent plain text into one span', () => {
  assert.deepEqual(editorRuns([
    { kind: 'text', text: '' },
    { kind: 'command', text: '/compact', command: catalog[0]! },
    { kind: 'text', text: ' the' },
    { kind: 'text', text: ' older history' },
  ]), [
    { kind: 'command', text: '/compact', command: catalog[0]! },
    { kind: 'text', text: ' the older history' },
  ])
})

test('a key changes when a token turns into a command, not when text is appended', () => {
  const typed = draftKey(draftRuns('/comp', catalog))
  const resolved = draftKey(draftRuns('/compact', catalog))
  assert.notEqual(typed, resolved, 'the gold token is a render transition')
  assert.notEqual(resolved, draftKey(draftRuns('/compact ', catalog)), 'a space is a text change')
  assert.equal(draftKey(draftRuns('/compact the', catalog)), draftKey(draftRuns('/compact the', catalog)))
  assert.notEqual(draftKey(draftRuns('/compact the', catalog)), draftKey(draftRuns('/compact thes', catalog)))
})

test('only the spans the renderer builds are the editor’s own shape', () => {
  assert.ok(canonicalRenderedElement('SPAN', []), 'a plain text span')
  assert.ok(canonicalRenderedElement('SPAN', ['class']), 'the gold token span')
})

test('a wrapper the editor typed for itself is a render transition', () => {
  assert.equal(canonicalRenderedElement('FONT', ['color']), false, "Chromium's typing style after clearing a command")
  assert.equal(canonicalRenderedElement('SPAN', ['style']), false, 'a styled span is not one the renderer builds')
  assert.equal(canonicalRenderedElement('SPAN', ['class', 'data-x']), false, 'a span carrying more than the class')
  assert.equal(canonicalRenderedElement('DIV', []), false, 'a block is not a run wrapper')
  assert.equal(canonicalRenderedElement('B', []), false, 'bold is not a run wrapper')
})
