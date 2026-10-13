<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import BrowserAttachments from '../../src/webview/components/BrowserAttachments.svelte'
  import type { BrowserElementContext } from '../../src/shared/browser-context.js'
  let { args }: { args: ComponentProps<typeof BrowserAttachments> } = $props()
  let attachments = $state<BrowserElementContext[]>([])
  $effect(() => { attachments = structuredClone($state.snapshot(args.attachments)) })
</script>

<BrowserAttachments {...args} {attachments} onremove={(id) => { args.onremove(id); attachments = attachments.filter((entry) => entry.id !== id) }} />
