import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HarnessRuntime } from '../runtime/harness-runtime.js'

test('bundled DSH preloads before request one and enforces duplicate/excluded loads on the wire', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-skills-runtime-'))
  const requests: any[] = []
  let resolveDone!: () => void
  let rejectDone!: (error: unknown) => void
  let done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const server = createServer(async (request, response) => {
    try {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      requests.push(body)
      const toolResults = body.messages.filter((entry: any) => entry.role === 'tool')
      const delta = toolResults.length || requests.length > 1 ? { role: 'assistant', content: 'Completed.' } : {
        role: 'assistant', tool_calls: ['one', 'three', 'two'].map((name, index) => ({ index, id: `load-${name}`, type: 'function', function: { name: 'skill', arguments: JSON.stringify({ name }) } })),
      }
      const chunk = (delta: any, reason: string | null) => `data: ${JSON.stringify({ id: 'skill-test', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(chunk(delta, null) + chunk({}, toolResults.length || requests.length > 1 ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n')
    } catch (error) { rejectDone(error); response.writeHead(500); response.end() }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const sessionId = randomUUID()
  const runtime = new HarnessRuntime({ onLifecycleError: rejectDone })
  const route = runtime.registerSession(sessionId, (event) => {
    if (event.notification.method === 'session.status' && event.notification.params?.status === 'idle') resolveDone()
  })
  try {
    for (const name of ['one', 'two', 'three']) {
      const root = join(directory, '.agents', 'skills', name)
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill ${name}\n---\nUNIQUE_INSTRUCTIONS_${name.toUpperCase()} {{literal-template}}\n`)
    }
    await runtime.start({ cwd: directory, dshHome: directory, sessionStorageRoot: join(directory, 'sessions'), provider: 'deepseek-official',
      model: 'deepseek-v4-flash', apiKey: 'local-test-only', baseUrl: `http://127.0.0.1:${address.port}`, sandboxMode: 'read-only', mcpServers: [] })
    const catalog = await runtime.skillCatalog(sessionId)
    assert.equal(catalog.complete, true)
    assert.ok(catalog.skills.some((skill) => skill.name === 'one'))
    await runtime.stageSkills(sessionId, { include: ['one'], exclude: ['three'], prompt: '/one test' })
    await runtime.prompt(sessionId, [{ type: 'text', text: '/one test' }])
    await done
    assert.equal(requests.length, 2)
    const first = JSON.stringify(requests[0])
    assert.match(first, /UNIQUE_INSTRUCTIONS_ONE/)
    assert.match(first, /\{\{literal-template\}\}/)
    assert.equal((first.match(/UNIQUE_INSTRUCTIONS_ONE/g) ?? []).length, 1, 'explicit invocation is deduplicated against preloading')
    assert.doesNotMatch(first, /UNIQUE_INSTRUCTIONS_TWO|UNIQUE_INSTRUCTIONS_THREE/)
    const tools = requests[1].messages.filter((entry: any) => entry.role === 'tool')
    assert.equal(tools.length, 3)
    assert.match(JSON.stringify(tools.find((entry: any) => entry.tool_call_id === 'load-one')), /already provided/)
    assert.doesNotMatch(JSON.stringify(tools.find((entry: any) => entry.tool_call_id === 'load-one')), /UNIQUE_INSTRUCTIONS_ONE/)
    assert.match(JSON.stringify(tools.find((entry: any) => entry.tool_call_id === 'load-three')), /excluded/)
    assert.match(JSON.stringify(tools.find((entry: any) => entry.tool_call_id === 'load-two')), /UNIQUE_INSTRUCTIONS_TWO/)

    done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
    await runtime.stageSkills(sessionId, { include: ['two'], exclude: ['one'], prompt: 'next' })
    await runtime.prompt(sessionId, [{ type: 'text', text: 'next' }])
    await done
    const snapshots = requests.at(-1).messages.map((entry: any) => typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content))
      .filter((text: string) => text.includes('Current Helix skills snapshot'))
    assert.match(snapshots.at(-1), /UNIQUE_INSTRUCTIONS_TWO/)
    assert.doesNotMatch(snapshots.at(-1), /UNIQUE_INSTRUCTIONS_ONE/)
  } finally {
    route.dispose()
    await runtime.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
