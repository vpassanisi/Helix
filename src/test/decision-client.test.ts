import assert from 'node:assert/strict'
import test from 'node:test'
import { decideSkills, type DecisionConnection } from '../host/decision-client.js'
import { decisionEndpoint, recentChatContext, effectiveSkills, type SkillSummary } from '../shared/skills.js'

const skills: SkillSummary[] = ['one', 'two', 'three', 'four'].map((name) => ({ name, description: `Use ${name}`, modelInvocable: true, userInvocable: true }))
const connection: DecisionConnection = { enabled: true, useMainConnection: false, format: 'typesafe', baseUrl: 'https://example.com/proxy/v1/', model: 'test-decision', threshold: 0.75 }

test('decision URLs preserve proxy prefixes and normalize only the final v1 segment', () => {
  assert.equal(decisionEndpoint('http://localhost:8080', 'typesafe'), 'http://localhost:8080/v1/systemone')
  assert.equal(decisionEndpoint('https://example.com/proxy/v1/', 'openai'), 'https://example.com/proxy/v1/decisions')
  assert.equal(decisionEndpoint('https://example.com/v1/proxy', 'openai'), 'https://example.com/v1/proxy/v1/decisions')
  for (const url of ['file:///tmp/key', 'https://user:key@example.com', 'https://example.com?a=1', 'https://example.com/#token']) assert.throws(() => decisionEndpoint(url, 'typesafe'))
})

test('TypeSafe noul adapter validates named answers and does not add a key for unauthenticated connections', async () => {
  const results = await decideSkills(connection, 'draft context', skills, new AbortController().signal, (async (url, init) => {
    assert.equal(String(url), 'https://example.com/proxy/v1/systemone')
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined)
    assert.equal(init?.redirect, 'error')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.state, 'draft context')
    assert.equal(body.questions.one.type, 'noul')
    assert.match(body.questions.one.instructions, /Use one/)
    return new Response(JSON.stringify({ answers: { one: { type: 'noul', noul: 0.75 }, two: { type: 'noul', noul: 2 }, three: { type: 'choice', noul: 0.9 }, alien: { type: 'noul', noul: 1 } } }))
  }) as typeof fetch)
  assert.deepEqual(results, [{ skillId: 'one', probability: 0.75 }, { skillId: 'two' }, { skillId: 'three' }, { skillId: 'four' }])
})

test('OpenAI predicates handle refusal, missing/duplicate names, and use only the provided key', async () => {
  const results = await decideSkills({ ...connection, format: 'openai', apiKey: 'separate-test-key' }, 'context', skills, new AbortController().signal, (async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer separate-test-key')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.input, 'context')
    assert.equal(body.questions[0].type, 'predicate')
    assert.equal(body.questions[0].name, 'one')
    return new Response(JSON.stringify({ answers: [{ name: 'one', type: 'predicate', probability: 0.8 }, { name: 'two', type: 'refusal' },
      { name: 'three', type: 'predicate', probability: 0.8 }, { name: 'three', type: 'predicate', probability: 0.9 }] }))
  }) as typeof fetch)
  assert.deepEqual(results, [{ skillId: 'one', probability: 0.8 }, { skillId: 'two' }, { skillId: 'three' }, { skillId: 'four' }])
  await assert.rejects(decideSkills(connection, '', [], new AbortController().signal, (async () => new Response('', { status: 401 })) as typeof fetch), /HTTP 401/)
})

test('recent context is bounded and manual exclusion overrides automatic/manual inclusion', () => {
  const context = recentChatContext(Array.from({ length: 8 }, (_, i) => ({ role: 'user', text: `${i}`.repeat(1400) })))
  assert.equal(context.length, 5)
  assert.equal(context.reduce((total, entry) => total + entry.text.length, 0), 6000)
  assert.ok(context.at(-1)?.text.startsWith('7'))
  assert.deepEqual(effectiveSkills(['one', 'two'], { include: ['two', 'three'], exclude: ['two'] }), ['one', 'three'])
})

test('HTTP failures retain Unsloth/OpenAI diagnostics without exposing the configured key', async () => {
  const failed = (body: unknown, status = 400) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
  await assert.rejects(decideSkills(connection, '', skills, new AbortController().signal,
    failed({ detail: { error_type: 'api_usage_error', message: 'Unknown model: any' } })), /HTTP 400\. Unknown model: any/)
  await assert.rejects(decideSkills(connection, '', skills, new AbortController().signal,
    failed({ error: { message: 'Not authenticated' } }, 401)), /HTTP 401\. Not authenticated/)
  await assert.rejects(decideSkills({ ...connection, apiKey: 'secret-value' }, '', skills, new AbortController().signal,
    failed({ detail: 'Invalid credential secret-value' }, 401)), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /\[redacted\]/)
      assert.equal(error.message.includes('secret-value'), false)
      return true
    })
})
