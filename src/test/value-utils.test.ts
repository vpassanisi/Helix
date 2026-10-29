import assert from 'node:assert/strict'
import test from 'node:test'
import { countLines, escapeHtml, isRecord, parsePayload, responseKey, stringValue } from '../shared/value-utils.js'

test('isRecord accepts plain objects only', () => {
  assert.equal(isRecord({}), true)
  assert.equal(isRecord({ a: 1 }), true)
  assert.equal(isRecord([]), false)
  assert.equal(isRecord(null), false)
  assert.equal(isRecord('text'), false)
  assert.equal(isRecord(42), false)
})

test('stringValue keeps non-empty strings and drops everything else', () => {
  assert.equal(stringValue('kept'), 'kept')
  assert.equal(stringValue(''), undefined)
  assert.equal(stringValue(7), undefined)
  assert.equal(stringValue(null), undefined)
  assert.equal(stringValue({}), undefined)
})

test('parsePayload accepts objects, JSON object strings, and rejects the rest', () => {
  assert.deepEqual(parsePayload({ a: 1 }), { a: 1 })
  assert.deepEqual(parsePayload('{"a":1}'), { a: 1 })
  assert.equal(parsePayload('[1,2]'), undefined, 'a JSON array is not a payload')
  assert.equal(parsePayload('42'), undefined, 'a JSON scalar is not a payload')
  assert.equal(parsePayload('not json'), undefined)
  assert.equal(parsePayload(7), undefined)
  assert.equal(parsePayload(null), undefined)
})

test('responseKey maps turn and step to a stable key', () => {
  assert.equal(responseKey({ turn: 2, step: 0 }), '2:0')
  assert.equal(responseKey({ turn: 0, step: 5 }), '0:5')
  assert.equal(responseKey({ turn: 2 }), undefined)
  assert.equal(responseKey({ turn: 1.5, step: 1 }), undefined)
  assert.equal(responseKey({}), undefined)
})

test('escapeHtml covers the raw-markup render set', () => {
  assert.equal(escapeHtml('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d &quot;e&quot;')
  assert.equal(escapeHtml(''), '')
  assert.equal(escapeHtml('no specials'), 'no specials')
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
})

test('countLines counts blank and single line strings', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines('one'), 1)
  assert.equal(countLines('one\ntwo'), 2)
  assert.equal(countLines('one\r\ntwo\rthree'), 3)
  assert.equal(countLines('trailing\n'), 2)
})
