<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import DecisionSettings from '../src/webview/components/DecisionSettings.svelte'
  import Preview from './previews/DecisionSettingsPreview.svelte'
  import { DEFAULT_DECISION_SETTINGS } from '../src/shared/skills.js'

  const { Story } = defineMeta({
    title: 'Settings/DecisionSettings', component: DecisionSettings, render: template,
    args: { decisions: { ...DEFAULT_DECISION_SETTINGS, enabled: true, model: 'default' }, mainUrl: 'http://localhost:8080', provider: 'llm-pi-ai', keyConfigured: false, apiKey: '', clearKey: false },
  })
</script>

{#snippet template(args: ComponentProps<typeof DecisionSettings>)}
  <Preview {args} />
{/snippet}

<Story name="Main connection" />
<Story name="Separate connection" args={{ decisions: { ...DEFAULT_DECISION_SETTINGS, enabled: true, useMainConnection: false, baseUrl: 'http://localhost:8080', model: 'default' }, keyConfigured: true }} />
<Story name="Disabled" args={{ decisions: { ...DEFAULT_DECISION_SETTINGS } }} />
