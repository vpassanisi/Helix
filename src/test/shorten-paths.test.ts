import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PATH_TAIL_SEGMENTS, shortenPaths } from '../webview/lib/shorten-paths.js'

test('shortens a long absolute path to its tail', () => {
  assert.equal(
    shortenPaths('Read /Users/vinny/Documents/Code/DSH VScode extension/src/webview/components/ToolCallCard.svelte'),
    'Read \u2026/Code/DSH VScode extension/src/webview/components/ToolCallCard.svelte',
  )
})

test('keeps the parent folder and the file name', () => {
  const shortened = shortenPaths('Edit /home/dev/project/src/shared/harness-events.ts')
  assert.equal(shortened, 'Edit \u2026/shared/harness-events.ts')
  assert.equal(shortened.split('/').length - 1, PATH_TAIL_SEGMENTS)
})

test('shortens a path that fills the whole line', () => {
  assert.equal(shortenPaths('/a/b/c/d/e.ts'), '\u2026/d/e.ts')
})

test('leaves a short path alone', () => {
  assert.equal(shortenPaths('Read src/webview/components/ToolCallCard.svelte (30 - 60)'), 'Read src/webview/components/ToolCallCard.svelte (30 - 60)')
  assert.equal(shortenPaths('Read /a/b.ts'), 'Read /a/b.ts')
})

test('shortens a home-relative path', () => {
  assert.equal(shortenPaths('Run ~/.agents/skills/asd-ste100/SKILL.md'), 'Run \u2026/asd-ste100/SKILL.md')
})

test('shortens a dot-relative path', () => {
  assert.equal(shortenPaths('Patch ../../plugins/dsh-otel-plugin/src/adapter.ts'), 'Patch \u2026/src/adapter.ts')
})

test('leaves a URL alone', () => {
  assert.equal(shortenPaths('Fetch https://example.com/a/b/c/d/e'), 'Fetch https://example.com/a/b/c/d/e')
})

test('shortens a Windows drive path and keeps backslashes', () => {
  assert.equal(shortenPaths('Edit C:\\Users\\dev\\project\\src\\main.ts'), 'Edit \u2026\\src\\main.ts')
})

test('shortens a Windows share path', () => {
  assert.equal(shortenPaths('Read \\\\fileserver\\share\\a\\b\\note.txt'), 'Read \u2026\\b\\note.txt')
})

test('shortens every path in one line', () => {
  assert.equal(
    shortenPaths('Move /a/b/c/d/one.ts to /a/b/c/d/two.ts'),
    'Move \u2026/d/one.ts to \u2026/d/two.ts',
  )
})

test('passes text with no path through untouched', () => {
  assert.equal(shortenPaths('List files in the current directory'), 'List files in the current directory')
  assert.equal(shortenPaths(''), '')
})

test('keeps the quotes around a shortened path', () => {
  assert.equal(shortenPaths('Write "/a/b/c/d/e.ts"'), 'Write "\u2026/d/e.ts"')
})
