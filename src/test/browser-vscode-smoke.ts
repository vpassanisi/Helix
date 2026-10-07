// Run explicitly in an Extension Development Host; excluded from the Node unit suite.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import * as vscode from 'vscode'
import { BrowserContextController } from '../host/browser-context-controller.js'
import { BrowserCdpClient } from '../runtime/browser-cdp.js'
import { isRecord } from '../shared/value-utils.js'

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Browser smoke test timed out')
}

export async function run(): Promise<void> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(request.url === '/frame'
      ? '<button id="framed">Frame button</button>'
      : '<!doctype html><title>Helix Browser Test</title><style>body{padding:40px;font:16px sans-serif}button{padding:20px;color:blue;margin:10px}</style><h1>Helix picker test</h1><button id="first" onclick="window.activations++">First</button><button id="second">Second</button><div id="shadow"></div><iframe src="/frame"></iframe><script>window.activations=0;document.querySelector("#shadow").attachShadow({mode:"open"}).innerHTML="<button id=shadow-button>Shadow button</button>"</script>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  let tab: vscode.BrowserTab | undefined
  let client: BrowserCdpClient | undefined
  let controller: BrowserContextController | undefined
  try {
    tab = await vscode.window.openBrowserTab(`http://127.0.0.1:${address.port}`)
    client = new BrowserCdpClient(await tab.startCDPSession(), () => undefined, () => undefined)
    const targets = await client.request('Target.getTargets')
    assert.ok(Array.isArray(targets.targetInfos))
    const target = targets.targetInfos.find((entry) => isRecord(entry) && entry.type === 'page')
    assert.ok(isRecord(target))
    const session = await client.request('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    assert.equal(typeof session.sessionId, 'string')
    const targetSession = session.sessionId as string
    const evaluate = async (expression: string) => {
      const result = await client!.request('Runtime.evaluate', { expression, returnByValue: true }, targetSession)
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return isRecord(result.result) ? result.result.value : undefined
    }
    await until(async () => await evaluate('document.readyState === "complete" && !!document.querySelector("#second")') === true)
    let sessionId = 'smoke-chat'
    controller = new BrowserContextController({ sessionId: () => sessionId, maxCharacters: () => 32_000, busy: () => false, onState: () => undefined })
    assert.equal(controller.state.available, true)
    await controller.toggle()
    assert.equal(controller.state.picking, true, controller.state.message)
    assert.equal(await evaluate('!!document.querySelector("[data-helix-picker]")'), true)
    await evaluate('(() => {const button=document.querySelector("#first");const r=button.getBoundingClientRect();button.dispatchEvent(new PointerEvent("pointermove", {bubbles:true,composed:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}))})()')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const screenshot = await client.request('Page.captureScreenshot', { format: 'png' }, targetSession)
    if (typeof screenshot.data === 'string') await writeFile('/tmp/helix-browser-hover.png', Buffer.from(screenshot.data, 'base64'))
    await evaluate('document.querySelector("#first").click();document.querySelector("#second").click()')
    await until(() => controller!.state.attachments.length === 2)
    assert.equal(controller.state.picking, true, 'Selection must remain active after clicks')
    assert.equal(await evaluate('window.activations'), 0, 'Selection must suppress page actions')
    assert.match(controller.state.attachments[0].html, /id="first"/)
    assert.match(controller.state.attachments[0].css, /color: rgb\(0, 0, 255\)/)
    await evaluate('document.querySelector("#shadow").shadowRoot.querySelector("button").click()')
    await until(() => controller!.state.attachments.length === 3)
    assert.match(controller.state.attachments[2].label, /shadow-button/)
    await evaluate('document.querySelector("iframe").contentDocument.querySelector("button").click()')
    await until(() => controller!.state.attachments.length === 4)
    assert.match(controller.state.attachments[3].url, /\/frame$/)
    const selectedId = controller.state.attachments[0].id
    controller.remove(sessionId, selectedId)
    assert.equal(controller.state.attachments.length, 3)
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))')
    await until(() => !controller!.state.picking)
    await until(async () => await evaluate('!document.querySelector("[data-helix-picker]")') === true)
    assert.equal(controller.state.attachments.length, 3)
    await evaluate('document.querySelector("#first").click()')
    assert.equal(await evaluate('window.activations'), 1, 'Page actions must recover after cleanup')
    const otherEditor = await vscode.workspace.openTextDocument({ content: 'A different editor is active', language: 'plaintext' })
    await vscode.window.showTextDocument(otherEditor)
    await controller.toggle()
    assert.equal(controller.state.picking, true, controller.state.message)
    assert.equal(vscode.window.activeBrowserTab, tab, 'Starting from another editor must reveal the last browser tab')
    await evaluate('location.href="/next"')
    await until(() => !controller!.state.picking)
    assert.equal(controller.state.attachments.length, 3)
    sessionId = 'new-chat'
    controller.reset(sessionId)
    assert.equal(controller.state.attachments.length, 0)
    await until(async () => await evaluate('document.readyState === "complete"') === true)
    await controller.toggle()
    assert.equal(controller.state.picking, true, controller.state.message)
    await tab.close()
    tab = undefined
    await until(() => !controller!.state.picking)
    await writeFile('/tmp/helix-browser-smoke-result.json', JSON.stringify({ passed: true, vscode: vscode.version, checks: ['continuous selection', 'HTML/CSS capture', 'click suppression', 'open shadow root', 'same-origin frame', 'removal', 'Escape cleanup', 'navigation cleanup', 'session reset'], hoverScreenshot: '/tmp/helix-browser-hover.png' }, null, 2))
  } catch (error) {
    await writeFile('/tmp/helix-browser-smoke-result.json', JSON.stringify({ passed: false, error: error instanceof Error ? error.stack : String(error) }, null, 2))
    throw error
  } finally {
    await controller?.dispose()
    await client?.close().catch(() => undefined)
    if (tab) await Promise.resolve(tab.close()).catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
