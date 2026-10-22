import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeChangeKind, mergeHostChanges, recordToolChange, toolChange } from '../shared/code-changes.js'
import type { CodeChange } from '../shared/code-changes.js'

const change = (path: string, kind: CodeChange['kind'], additions: number, deletions: number): CodeChange => ({ path, kind, additions, deletions })

test('merges host changes per path, keeps the largest counts, and sorts by path', () => {
  const merged = mergeHostChanges(
    [change('src/b.ts', 'modified', 4, 9), change('src/a.ts', 'created', 1, 0)],
    [change('src/b.ts', 'deleted', 2, 3), change('src/c.ts', 'modified', 5, 5)],
  )

  assert.deepEqual(merged.map((entry) => [entry.path, entry.kind, entry.additions, entry.deletions]), [
    ['src/a.ts', 'created', 1, 0],
    ['src/b.ts', 'deleted', 4, 9],
    ['src/c.ts', 'modified', 5, 5],
  ])
})

test('carries a renamed path forward and keeps it when only the older entry reported one', () => {
  const merged = mergeHostChanges(
    [{ path: 'src/new.ts', oldPath: 'src/old.ts', kind: 'renamed', additions: 0, deletions: 0 }],
    [change('src/new.ts', 'modified', 2, 1)],
  )
  assert.equal(merged[0].oldPath, 'src/old.ts')

  const replacement = mergeHostChanges(
    [change('src/new.ts', 'renamed', 0, 0)],
    [{ path: 'src/new.ts', oldPath: 'src/gone.ts', kind: 'modified', additions: 1, deletions: 1 }],
  )
  assert.equal(replacement[0].oldPath, 'src/gone.ts')
})

test('lets renames and deletions win over a prior modification', () => {
  assert.equal(mergeChangeKind('modified', 'renamed'), 'renamed')
  assert.equal(mergeChangeKind('modified', 'deleted'), 'deleted')
  assert.equal(mergeChangeKind('created', 'modified'), 'created')
  assert.equal(mergeChangeKind('renamed', 'modified'), 'renamed')
  assert.equal(mergeChangeKind('modified', 'modified'), 'modified')
})

test('adds counts for repeat tool calls on a path and takes the maximum against host-reported counts', () => {
  const derived = new Set<string>()
  const first = recordToolChange([], derived, change('src/a.ts', 'modified', 5, 2))
  assert.deepEqual(first, [change('src/a.ts', 'modified', 5, 2)])

  const added = recordToolChange(first, derived, change('src/a.ts', 'modified', 3, 1))
  assert.deepEqual(added, [change('src/a.ts', 'modified', 8, 3)])

  const againstHost = recordToolChange([change('src/b.ts', 'modified', 9, 4)], derived, change('src/b.ts', 'modified', 3, 1))
  assert.deepEqual(againstHost, [change('src/b.ts', 'modified', 9, 4)])
})

test('keeps the list sorted when a new path arrives', () => {
  const derived = new Set<string>()
  const list = recordToolChange([change('src/a.ts', 'modified', 1, 1)], derived, change('src/b.ts', 'created', 4, 0))
  assert.deepEqual(list.map((entry) => entry.path), ['src/a.ts', 'src/b.ts'])
})

test('reads file counts from write and edit arguments in snake_case and camelCase', () => {
  assert.deepEqual(toolChange('write', { file_path: 'src/a.ts', content: 'one\ntwo\nthree' }), { path: 'src/a.ts', kind: 'modified', additions: 3, deletions: 0 })
  assert.deepEqual(toolChange('mcp__demo__write', { path: 'src/a.ts', content: 'one' }), { path: 'src/a.ts', kind: 'modified', additions: 1, deletions: 0 })
  assert.deepEqual(toolChange('edit', { filePath: 'src/a.ts', old_string: 'one\ntwo', new_string: 'uno' }), { path: 'src/a.ts', kind: 'modified', additions: 1, deletions: 2 })
  assert.deepEqual(toolChange('str_replace_editor', { path: 'src/a.ts', command: 'create', file_text: 'one\ntwo' }), { path: 'src/a.ts', kind: 'created', additions: 2, deletions: 0 })
  assert.deepEqual(toolChange('str_replace_editor', { path: 'src/a.ts', command: 'str_replace', old_str: 'one', new_str: 'one\ntwo' }), { path: 'src/a.ts', kind: 'modified', additions: 2, deletions: 1 })
  assert.deepEqual(toolChange('str_replace_editor', { path: 'src/a.ts', command: 'insert', new_str: 'one' }), { path: 'src/a.ts', kind: 'modified', additions: 1, deletions: 0 })
})

test('returns no change for tools without a file path, a str_replace editor command, or patch text', () => {
  assert.equal(toolChange('bash', { command: 'ls' }), undefined)
  assert.equal(toolChange('write', { file_path: 'src/a.ts' }), undefined)
  assert.equal(toolChange('edit', { file_path: 'src/a.ts', new_string: 'one' }), undefined)
  assert.equal(toolChange('str_replace_editor', { file_path: 'src/a.ts', command: 'read_file' }), undefined)
})
