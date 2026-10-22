<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import ComposerModelPicker from '../../src/webview/components/ComposerModelPicker.svelte'
  import { ModelCatalogState } from '../../src/webview/lib/model-catalog.svelte.js'
  import { ComposerModelState } from '../../src/webview/lib/composer-model.svelte.js'

  let { args }: { args: ComponentProps<typeof ComposerModelPicker> } = $props()

  // The picker is wired through the same controllers the app uses, so picking a
  // model runs the real catalog lookup and effort preference.
  const catalog = new ModelCatalogState()
  const composerModel = new ComposerModelState((modelId) => catalog.find(modelId))
  $effect(() => {
    catalog.applyCatalog(args.models)
    composerModel.model = args.model
    composerModel.reasoningEffort = args.reasoningEffort ?? null
  })
</script>

<div class="flex min-h-[520px] items-end justify-end pr-[52px]">
  <ComposerModelPicker
    {...args}
    model={composerModel.model}
    reasoningEffort={composerModel.reasoningEffort}
    onModelSelect={(id) => {
      args.onModelSelect(id)
      composerModel.select(id)
    }}
    onReasoningEffortSelect={(effort) => {
      args.onReasoningEffortSelect(effort)
      composerModel.selectEffort(effort)
    }}
  />
</div>
