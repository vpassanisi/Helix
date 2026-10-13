<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import ModelsSettings from '../src/webview/components/ModelsSettings.svelte'
  import Preview from './previews/ModelsSettingsPreview.svelte'
  import { modelDrafts, discoveredModels, modelOptionLabel } from './fixtures.js'

  const { Story } = defineMeta({
    title: 'Settings/ModelsSettings', component: ModelsSettings, render: template,
    args: { modelDrafts, discoveredModels, modelsLoading: false, modelsError: '', modelCatalogLoading: false, modelCatalogSaving: false, modelCatalogError: '', modelOptionLabel, onAddModel: fn(), onRefreshModels: fn(), onSaveModels: fn(), onStatus: fn() },
  })
</script>

{#snippet template(args: ComponentProps<typeof ModelsSettings>)}
  <Preview {args} />
{/snippet}

<Story name="Populated" />
<Story name="Empty" args={{ modelDrafts: [] }} />
<Story name="Loading" args={{ modelCatalogLoading: true, modelsLoading: true }} />
<Story name="Saving" args={{ modelCatalogSaving: true }} />
<Story name="Catalog error" args={{ modelCatalogError: 'The saved model catalog could not be read.' }} />
<Story name="Discovery error" args={{ modelsError: 'The endpoint is unavailable.', discoveredModels: [] }} />
<Story name="Chat template" args={{ modelDrafts: [{ ...modelDrafts[0], reasoningFormat: 'chat-template', chatTemplateKwargsText: '{"enable_thinking":true}' }] }} />
