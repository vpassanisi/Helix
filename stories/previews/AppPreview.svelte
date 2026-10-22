<script lang="ts">
  import { untrack } from 'svelte'
  import App from '../../src/webview/App.svelte'
  import type { IncomingMessage, SidebarMessage, WebviewApi } from '../../src/webview/types.js'

  interface Props {
    messages: IncomingMessage[]
  }

  let { messages }: Props = $props()

  // The host stub: records what App sends, and replays the messages App expects.
  const sent = $state<SidebarMessage[]>([])
  const vscode: WebviewApi = { postMessage: (message: SidebarMessage) => { sent.push(message) } }

  // Parent effects run after the child mounts, so App has its listener by then.
  // The dispatch must be untracked: handling a host message reads and writes
  // App's state, and a tracked effect would re-run on every one of those writes.
  $effect(() => {
    const list = $state.snapshot(messages)
    untrack(() => {
      for (const message of list) window.dispatchEvent(new MessageEvent('message', { data: message }))
    })
  })
</script>

<div class="flex h-[520px] min-h-0 flex-col overflow-hidden">
  <App {vscode} />
  <p class="border-t border-white/10 px-3 py-1 text-xs opacity-70">Host received: {sent.map((message) => message.type).join(', ')}</p>
</div>
