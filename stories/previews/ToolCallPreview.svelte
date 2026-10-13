<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import { untrack } from 'svelte'
  import ToolCallCard from '../../src/webview/components/ToolCallCard.svelte'
  let { args }: { args: ComponentProps<typeof ToolCallCard> } = $props()
  let tool = $state(untrack(() => structuredClone($state.snapshot(args.tool))))
  $effect(() => { tool = structuredClone($state.snapshot(args.tool)) })
</script>

<div class="message tool">
  <ToolCallCard {tool} onapprove={(outcome) => {
    args.onapprove(outcome)
    if (tool.approval) tool = { ...tool, approval: { ...tool.approval, status: outcome } }
  }} />
</div>
