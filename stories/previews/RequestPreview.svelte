<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import RequestPreviewPanel from '../../src/webview/components/RequestPreviewPanel.svelte'
  import { requestPreview } from '../fixtures.js'
  type Args = ComponentProps<typeof RequestPreviewPanel>
  let { args }: { args: Args } = $props()
  let prompt = $state('')
  let showRawJson = $state(false)
  let previewState = $state<Args['state']>('idle')
  let preview = $state<Args['preview']>()
  $effect(() => { prompt = args.prompt; showRawJson = args.showRawJson; previewState = args.state; preview = args.preview })
</script>

<RequestPreviewPanel {...args} bind:prompt bind:showRawJson state={previewState} {preview}
  onPreview={() => { args.onPreview(); previewState = 'success'; preview = requestPreview }}
  onCancel={() => { args.onCancel(); previewState = 'cancelled'; preview = undefined }} />
