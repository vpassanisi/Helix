<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import ComposerModelPicker from '../src/webview/components/ComposerModelPicker.svelte'
  import Preview from './previews/ComposerModelPreview.svelte'
  import { models, modelOptionLabel } from './fixtures.js'

  const { Story } = defineMeta({
    title: 'Chat/ComposerModelPicker', component: ComposerModelPicker, render: template,
    args: { models, model: models[0].id, reasoningEffort: 'high', modelChanging: false, modelOptionLabel, onModelSelect: fn(), onReasoningEffortSelect: fn() },
  })
</script>

{#snippet template(args: ComponentProps<typeof ComposerModelPicker>)}
  <Preview {args} />
{/snippet}

<Story name="Graded reasoning" />
<Story name="Binary thinking" args={{ model: models[1].id, reasoningEffort: null }} />
<Story name="No models" args={{ models: [], model: '', reasoningEffort: null }} />
<Story name="Changing model" args={{ modelChanging: true }} />
