import assert from 'node:assert/strict'
import test from 'node:test'
import { browserPickerExpression } from '../runtime/browser-picker-script.js'

test('the expression installs the picker with the given binding, cleanup, and budget', () => {
  const expression = browserPickerExpression('helixBrowserPick', 'helixBrowserPickCleanup', 12_000)
  assert.match(expression, /^\(/)
  assert.ok(expression.includes('"helixBrowserPick"'), 'the binding name is serialized into the call')
  assert.ok(expression.includes('"helixBrowserPickCleanup"'), 'the cleanup name is serialized into the call')
  assert.ok(expression.includes(', 12000)'), 'the character budget is passed through')
  assert.ok(expression.includes('data-helix-picker'), 'the picker root marker is part of the bundled function')
})

test('the expression is syntactically valid JavaScript', () => {
  const expression = browserPickerExpression('bind', 'cleanup', 500)
  assert.doesNotThrow(() => new Function(expression))
})

test('the bundled picker keeps its self-contained contract', () => {
  const expression = browserPickerExpression('a', 'b', 100)
  assert.ok(expression.includes('Escape'), 'Escape cancels the picker')
  assert.ok(expression.includes('pointer-events:none'))
  assert.ok(expression.includes('truncated'), 'selections report when the budget truncated the payload')
})
