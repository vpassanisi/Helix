<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import { untrack } from 'svelte'
  import GenUiCard from '../../src/webview/components/GenUiCard.svelte'

  let { args }: { args: ComponentProps<typeof GenUiCard> } = $props()

  let view = $state(untrack(() => structuredClone($state.snapshot(args.view))))
  $effect(() => { view = structuredClone($state.snapshot(args.view)) })
</script>

<div class="message ui">
  <GenUiCard {view} onui={(action) => {
    args.onui(action)
    if (action.kind === 'dismiss') view = { ...view, status: 'dismissed' }
  }} />
</div>
