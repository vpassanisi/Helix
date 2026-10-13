<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import DecisionSettings from '../../src/webview/components/DecisionSettings.svelte'
  import { DEFAULT_DECISION_SETTINGS } from '../../src/shared/skills.js'
  let { args }: { args: ComponentProps<typeof DecisionSettings> } = $props()
  let decisions = $state({ ...DEFAULT_DECISION_SETTINGS })
  let apiKey = $state('')
  let clearKey = $state(false)
  $effect(() => {
    decisions = structuredClone($state.snapshot(args.decisions))
    apiKey = args.apiKey ?? ''
    clearKey = args.clearKey ?? false
  })
</script>

<DecisionSettings {...args} bind:decisions bind:apiKey bind:clearKey />
