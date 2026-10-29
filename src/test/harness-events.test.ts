import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assistantTextBlocks,
  contextUsageTotal,
  numericValue,
  stringifyPayload,
  toolCallId,
  toolResultCallId,
  toolResultIsError,
  toolResultText,
  toolStepKey,
} from '../shared/harness-events.js'

const link = (overrides: Partial<Parameters<typeof toolResultCallId>[0]> = {}) => ({
  data: {},
  message: {},
  sessionId: 'session-a',
  callsByStep: {},
  activeSessionId: 'session-root',
  ...overrides,
})

test('prefers the explicit call id over source, content blocks, and step keys', () => {
  assert.equal(toolResultCallId(link({
    data: { callId: 'call-direct' },
    message: { source: { callId: 'call-source' }, content: [{ toolCallId: 'call-block' }] },
    callsByStep: { 'session-a:1:2': 'call-step' },
  }), 'fallback'), 'call-direct')

  assert.equal(toolResultCallId(link({
    message: { source: { callId: 'call-source' }, content: [{ toolCallId: 'call-block' }] },
  }), 'fallback'), 'call-source')

  assert.equal(toolResultCallId(link({
    message: { content: [{ type: 'text' }, { toolCallId: 'call-block' }] },
  }), 'fallback'), 'call-block')
})

test('resolves a result through the step map, then the turn/step key, then the fallback', () => {
  assert.equal(toolResultCallId(link({
    data: { turn: 1, step: 2 },
    callsByStep: { 'session-a:1:2': 'call-step' },
  }), 'fallback'), 'call-step')

  assert.equal(toolResultCallId(link({ data: { turn: 3, step: 4 } }), 'fallback'), '3:4')
  assert.equal(toolResultCallId(link({ data: { turn: 3 } }), 'fallback'), 'fallback')
})

test('builds step keys against the event session, falling back to the active session', () => {
  assert.equal(toolStepKey('session-a', { turn: 2, step: 1 }, 'session-root'), 'session-a:2:1')
  assert.equal(toolStepKey(undefined, { turn: 2, step: 1 }, 'session-root'), 'session-root:2:1')
  assert.equal(toolStepKey('session-a', { turn: 2 }, 'session-root'), undefined)
})

test('uses the call id, then the response key, then the caller fallback', () => {
  assert.equal(toolCallId({ callId: 'call-1' }, 'tool-call-7'), 'call-1')
  assert.equal(toolCallId({ turn: 1, step: 3 }, 'tool-call-7'), '1:3')
  assert.equal(toolCallId({}, 'tool-call-7'), 'tool-call-7')
})

test('flattens tool result content of every shape into text', () => {
  assert.equal(toolResultText('plain'), 'plain')
  assert.equal(toolResultText([{ text: 'first' }, { text: 'second' }]), 'first\n\nsecond')
  assert.equal(toolResultText({ content: [{ text: 'nested' }] }), 'nested')
  assert.equal(toolResultText({ value: { ok: true } }), '{\n  "ok": true\n}')
  assert.equal(toolResultText(null), '')
})

test('detects an error flag nested inside result content', () => {
  assert.equal(toolResultIsError({ content: [{ text: 'ok' }, { isError: true }] }), true)
  assert.equal(toolResultIsError([{ text: 'ok' }]), false)
  assert.equal(toolResultIsError('plain'), false)
})

test('sums usage counters and rejects negative or non-finite numbers', () => {
  assert.equal(contextUsageTotal({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 }), 20)
  assert.equal(contextUsageTotal({ outputTokens: 4 }), 4)
  assert.equal(contextUsageTotal({ inputTokens: -1 }), undefined)
  assert.equal(contextUsageTotal({ inputTokens: Number.NaN }), undefined)
  assert.equal(contextUsageTotal(undefined), undefined)
  assert.equal(numericValue(0), 0)
  assert.equal(numericValue('12'), undefined)
})

test('keeps only text and reasoning blocks from an assistant message', () => {
  assert.deepEqual(assistantTextBlocks([
    { type: 'text', text: 'answer' },
    { type: 'reasoning', text: 'plan' },
    { type: 'tool_use', text: 'ignored' },
    { type: 'text' },
    'string',
  ]), [{ role: 'assistant', text: 'answer' }, { role: 'reasoning', text: 'plan' }])
  assert.deepEqual(assistantTextBlocks('not an array'), [])
})

test('stringifies payloads without throwing on circular structures', () => {
  const circular: Record<string, unknown> = { name: 'loop' }
  circular.self = circular
  assert.equal(stringifyPayload(circular), '[object Object]')
  assert.equal(stringifyPayload('plain'), 'plain')
})
