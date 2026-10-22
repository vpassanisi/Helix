<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import RequestPreviewPanel from '../../src/webview/components/RequestPreviewPanel.svelte'

  type Args = ComponentProps<typeof RequestPreviewPanel>
  let { args }: { args: Args } = $props()
  let showRawJson = $state(false)
  let previewState = $state<Args['state']>('idle')
  let preview = $state<Args['preview']>()
  $effect(() => { showRawJson = args.showRawJson; previewState = args.state; preview = args.preview })
</script>

<div class="settings-view h-[440px]">
  <RequestPreviewPanel {...args} bind:showRawJson state={previewState} {preview}
    onCancel={() => { args.onCancel(); previewState = 'cancelled'; preview = undefined }} />
</div>
