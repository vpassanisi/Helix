import assert from 'node:assert/strict'
import test from 'node:test'
import { copyTextFor, isCopyKey, type CopyKey } from '../webview/lib/clipboard-copy.js'

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

function key(over: Partial<CopyKey> = {}): CopyKey {
  return { key: 'c', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over }
}

function selection(text: string, collapsed = text.length === 0): Selection {
  return { toString: () => text, isCollapsed: collapsed, rangeCount: collapsed ? 0 : 1 } as unknown as Selection
}

test('the copy chord is Cmd+C on macOS, and Ctrl+C on every platform', () => {
  assert.equal(isCopyKey(key({ metaKey: true }), MAC), true)
  assert.equal(isCopyKey(key({ ctrlKey: true }), MAC), true)
  assert.equal(isCopyKey(key({ ctrlKey: true }), WINDOWS), true)
})

test('a bare letter, and a longer chord, are left to VS Code', () => {
  assert.equal(isCopyKey(key({}), MAC), false)
  assert.equal(isCopyKey(key({ metaKey: true }), WINDOWS), false)
  assert.equal(isCopyKey(key({ metaKey: true, shiftKey: true }), MAC), false)
  assert.equal(isCopyKey(key({ metaKey: true, altKey: true }), MAC), false)
  assert.equal(isCopyKey(key({ key: 'x', metaKey: true }), MAC), false)
  assert.equal(isCopyKey(key({ key: 'Copy', metaKey: true }), MAC), false)
})

test('a copy keypress with a capital C is still the copy chord', () => {
  assert.equal(isCopyKey(key({ key: 'C', metaKey: true, shiftKey: true }), MAC), false)
  assert.equal(isCopyKey({ ...key({ metaKey: true }), key: 'C' }, MAC), true)
})

test('the text to copy is the document selection when the keypress is not in a field', () => {
  assert.equal(copyTextFor({} as EventTarget, selection('the answer\nsecond line')), 'the answer\nsecond line')
})

function field(tag: 'INPUT' | 'TEXTAREA', value: string, from: number, to: number): EventTarget {
  return { tagName: tag, value, selectionStart: from, selectionEnd: to } as unknown as EventTarget
}

test('the selection inside a field is the text to copy, whichever way it was dragged', () => {
  assert.equal(copyTextFor(field('INPUT', 'fix the parser', 4, 10), selection('')), 'the pa')
  assert.equal(copyTextFor(field('TEXTAREA', 'composer draft', 8, 0), null), 'composer')
})

test('a field that reports no selection falls back to the document selection', () => {
  assert.equal(copyTextFor(field('INPUT', 'plain draft', 3, 3), selection('transcript text')), 'transcript text')
  assert.equal(copyTextFor(field('INPUT', 'plain draft', 3, 3), null), '')
})

test('no selection, and no selection object, leaves the keypress alone', () => {
  assert.equal(copyTextFor(null, selection('')), '')
  assert.equal(copyTextFor(null, null), '')
  assert.equal(copyTextFor(null, selection('ws', true)), '')
})
