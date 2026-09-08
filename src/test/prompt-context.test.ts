import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContentBlock } from '@deepseek-ai/dsh-sdk-client'
import { buildPromptContent } from '../runtime/prompt-context.js'

function textOf(block: ContentBlock): string {
  assert.equal(block.type, 'text')
  if (block.type !== 'text') throw new Error('Expected a text content block')
  return block.text
}

test('builds a prompt with editor context first', () => {
  const content = buildPromptContent('Explain this', {
    fileLabel: 'src/example.ts',
    languageId: 'typescript',
    ranges: [{ startLine: 2, startColumn: 1, endLine: 3, endColumn: 4, text: 'const value = 1' }],
  })

  assert.equal(content.length, 2)
  assert.match(textOf(content[0]), /File: src\/example\.ts/)
  assert.match(textOf(content[0]), /const value = 1/)
  assert.equal(textOf(content[1]), 'Explain this')
})

test('sends only the prompt without a selection', () => {
  const content = buildPromptContent('Say hello', undefined)
  assert.deepEqual(content, [{ type: 'text', text: 'Say hello' }])
})

test('supports multiple selections and truncates context', () => {
  const content = buildPromptContent('Summarize', {
    fileLabel: 'main.ts',
    languageId: 'typescript',
    ranges: [
      { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4, text: 'abcdef' },
      { startLine: 4, startColumn: 1, endLine: 4, endColumn: 4, text: 'ghijkl' },
    ],
  }, 8)

  assert.match(textOf(content[0]), /abcdef/)
  assert.match(textOf(content[0]), /gh/)
  assert.match(textOf(content[0]), /truncated/i)
})

test('rejects an empty prompt', () => {
  assert.throws(() => buildPromptContent('  ', undefined), /prompt is required/i)
})
