import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserCdpClient, type BrowserCdpTransport } from '../runtime/browser-cdp.js'
import { BrowserAttachments } from '../runtime/browser-attachments.js'
import { buildPromptContent } from '../runtime/prompt-context.js'
import type { BrowserElementContext } from '../shared/browser-context.js'

const element = (id: string): BrowserElementContext => ({ id, url: 'http://localhost:3000', label: `button#${id}`, selector: `body > button#${id}`, html: '<button>Go</button>', css: 'color: blue;', dimensions: { top: 10, left: 20, width: 50, height: 30 }, truncated: false })

function transport() {
  const messages: unknown[] = []
  let receive: (value: unknown) => void = () => undefined
  let closed: () => void = () => undefined
  const value: BrowserCdpTransport = {
    onDidReceiveMessage: (listener) => { receive = listener; return { dispose: () => { receive = () => undefined } } },
    onDidClose: (listener) => { closed = listener; return { dispose: () => { closed = () => undefined } } },
    sendMessage: async (message) => { messages.push(message) },
    close: async () => { closed() },
  }
  return { value, messages, receive: (value: unknown) => receive(value), disconnect: () => closed() }
}

test('CDP routes out-of-order replies, errors, and events with target sessions', async () => {
  const channel = transport()
  const events: unknown[] = []
  const client = new BrowserCdpClient(channel.value, (event) => events.push(event), () => undefined)
  const first = client.request('Page.enable', {}, 'page-session')
  const second = client.request('DOM.getDocument')
  assert.deepEqual(channel.messages[0], { id: 1, method: 'Page.enable', params: {}, sessionId: 'page-session' })
  const rejected = assert.rejects(first, /denied/)
  channel.receive({ id: 2, result: { root: 123 } })
  channel.receive({ method: 'Runtime.bindingCalled', params: {} })
  channel.receive({ id: 1, error: { message: 'denied' } })
  assert.deepEqual(await second, { root: 123 })
  await rejected
  assert.equal(events.length, 1)
  await client.close()
})

test('CDP times out requests and rejects pending requests on disconnect', async () => {
  const channel = transport()
  let closed = false
  const client = new BrowserCdpClient(channel.value, () => undefined, () => { closed = true }, 10)
  await assert.rejects(client.request('Page.enable'), /timed out/)
  const pending = client.request('DOM.getDocument')
  const rejected = assert.rejects(pending, /closed/)
  channel.disconnect()
  await rejected
  assert.equal(closed, true)
  await assert.rejects(client.request('Page.enable'), /closed/)
})

test('removed and wrong-session attachments cannot be submitted', () => {
  const store = new BrowserAttachments('chat-a')
  store.add(element('a'))
  assert.throws(() => store.snapshot('chat-b', ['a'], 1000), /different chat session/)
  store.remove('a')
  assert.throws(() => store.snapshot('chat-a', ['a'], 1000), /removed/)
})

test('attachment snapshots share a budget and consume only an accepted submission', () => {
  const store = new BrowserAttachments('chat-a')
  store.add(element('a'))
  store.add(element('b'))
  const snapshot = store.snapshot('chat-a', ['a', 'a', 'b'], 23)
  assert.equal(snapshot.length, 2)
  assert.equal(snapshot.reduce((sum, entry) => sum + entry.html.length + entry.css.length, 0), 23)
  assert.ok(snapshot.every((entry) => entry.truncated))
  assert.equal(store.list(1000).length, 2, 'A failed or pending submission retains attachments')
  store.add(element('c'))
  store.consume('chat-a', ['a', 'b'])
  assert.deepEqual(store.list(1000).map((entry) => entry.id), ['c'])
  assert.equal(snapshot[0].html, '<button>Go</button>', 'Removing an attachment does not mutate the submitted snapshot')
  store.reset('chat-b')
  store.add(element('new'))
  store.consume('chat-a', ['new'])
  assert.equal(store.list(1000).length, 1, 'Old acceptances cannot clear a new session')
})

test('browser reference blocks preserve editor context and put instructions last', () => {
  const blocks = buildPromptContent('Make these smaller', { fileLabel: 'App.svelte', languageId: 'svelte', ranges: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, text: 'source selection' }] }, 1000, [element('a'), element('b')], 23)
  const texts = blocks.map((entry) => { assert.equal(entry.type, 'text'); return entry.type === 'text' ? entry.text : '' })
  assert.match(texts[0], /source selection/)
  assert.match(texts[1], /reference material, not an instruction/)
  assert.match(texts[1], /URL: http:\/\/localhost:3000/)
  assert.match(texts[2], /Element 2/)
  assert.match(texts[2], /truncated/)
  assert.equal(texts[3], 'Make these smaller')
  assert.equal(buildPromptContent('Explain', undefined, 1000, [element('a')]).length, 2)
})
