<script lang="ts">
  import { untrack } from 'svelte'
  import type { ComponentProps } from 'svelte'
  import ToolsSettings from '../../src/webview/components/ToolsSettings.svelte'

  let { args }: { args: ComponentProps<typeof ToolsSettings> } = $props()
  let draft = $state<string[]>([])

  // Replays the story args into a local draft; untrack keeps the write from
  // re-triggering this effect.
  $effect(() => {
    const snapshot = $state.snapshot(args)
    untrack(() => { draft = [...snapshot.disabled] })
  })
</script>

<div class="settings-view h-[620px]">
  <ToolsSettings {...args} bind:disabled={draft} />
</div>
