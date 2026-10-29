import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GitChangeTracker } from '../runtime/git-change-tracker.js'
import type { CodeChangeUpdate } from '../runtime/change-tracker.js'

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error) => (error === null ? resolve() : reject(error)))
  })
}

async function createTestRepo(files: Record<string, string> = {}): Promise<string> {
  const repo = join(tmpdir(), `helix-git-tracker-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(repo, { recursive: true })
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(repo, name), contents, 'utf8')
  }
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-q', '-m', 'baseline'])
  return repo
}

async function waitForFrame(frames: CodeChangeUpdate[], predicate: (frame: CodeChangeUpdate) => boolean, deadlineMs = 10_000): Promise<CodeChangeUpdate> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const match = frames.find(predicate)
    if (match !== undefined) return match
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`no matching frame within ${deadlineMs}ms: ${JSON.stringify(frames)}`)
}

test('a workspace that is not a git work tree reports no changes', async () => {
  const plain = join(tmpdir(), `helix-git-tracker-plain-${Date.now()}`)
  await mkdir(plain, { recursive: true })
  const frames: CodeChangeUpdate[] = []
  const tracker = new GitChangeTracker({ fsPath: plain } as never, (update) => frames.push(update))
  try {
    tracker.start('session')
    const frame = await waitForFrame(frames, (update) => update.active)
    assert.deepEqual(frame, { sessionId: 'session', changes: [], active: true })
  } finally {
    tracker.dispose()
    await rm(plain, { recursive: true, force: true })
  }
})

test('a missing workspace root reports no changes', async () => {
  const frames: CodeChangeUpdate[] = []
  const tracker = new GitChangeTracker(undefined, (update) => frames.push(update))
  try {
    tracker.start('session')
    const frame = await waitForFrame(frames, (update) => update.active)
    assert.deepEqual(frame, { sessionId: 'session', changes: [], active: true })
  } finally {
    tracker.dispose()
  }
})

test('a git work tree diffs the baseline against live and final changes', async () => {
  const repo = await createTestRepo({ 'a.txt': 'one\ntwo\n', 'c.txt': 'c\n' })
  const frames: CodeChangeUpdate[] = []
  const tracker = new GitChangeTracker({ fsPath: repo } as never, (update) => frames.push(update))
  try {
    tracker.start('session')
    const baseline = await waitForFrame(frames, (update) => update.active)
    assert.deepEqual(baseline.changes, [], 'a clean tree starts with no changes')

    await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'b\n', 'utf8')
    await rm(join(repo, 'c.txt'))

    const live = await waitForFrame(frames, (update) => update.active && update.changes.length === 3)
    assert.deepEqual(live.changes, [
      { path: 'a.txt', kind: 'modified', additions: 1, deletions: 0 },
      { path: 'b.txt', kind: 'created', additions: 1, deletions: 0 },
      { path: 'c.txt', kind: 'deleted', additions: 0, deletions: 1 },
    ])

    // Let the next poll tick land so no git snapshot is in flight when the
    // turn finishes; the tick is a no-op on an unchanged tree.
    await new Promise((resolve) => setTimeout(resolve, 1_600))

    tracker.finish('other-session')
    assert.equal(frames.length, frames.filter((update) => update.active).length, 'a finish for another session is ignored')

    tracker.finish('session')
    const final = await waitForFrame(frames, (update) => !update.active)
    assert.equal(final.sessionId, 'session')
    assert.equal(final.changes.length, 3)
    assert.equal(final.changes[0].path, 'a.txt')

    tracker.dispose()
    assert.deepEqual(
      (await new Promise<CodeChangeUpdate[]>((resolve) => {
        const before = frames.length
        setTimeout(() => resolve(frames.slice(before)), 2_000)
      })).length,
      0,
      'a disposed tracker stops reporting',
    )
  } finally {
    tracker.dispose()
    await rm(repo, { recursive: true, force: true })
  }
})
