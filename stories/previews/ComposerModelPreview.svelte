<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import ComposerModelPicker from '../../src/webview/components/ComposerModelPicker.svelte'
  import { preferredReasoningEffort } from '../../src/runtime/model-catalog.js'
  let { args }: { args: ComponentProps<typeof ComposerModelPicker> } = $props()
  let model = $state('')
  let reasoningEffort = $state<string | null>(null)
  $effect(() => { model = args.model; reasoningEffort = args.reasoningEffort })
</script>

<div class="flex min-h-[520px] items-end justify-end pr-[52px]">
  <ComposerModelPicker {...args} {model} {reasoningEffort}
    onModelSelect={(id) => {
      args.onModelSelect(id)
      model = id
      reasoningEffort = preferredReasoningEffort(args.models.find((entry) => entry.id === id)) ?? null
    }}
    onReasoningEffortSelect={(effort) => { args.onReasoningEffortSelect(effort); reasoningEffort = effort }} />
</div>
