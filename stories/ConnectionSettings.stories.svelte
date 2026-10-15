<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import ConnectionSettings from '../src/webview/components/ConnectionSettings.svelte'
  import Preview from './previews/ConnectionSettingsPreview.svelte'
  import { DEFAULT_DECISION_SETTINGS } from '../src/shared/skills.js'
  import { DEFAULT_OTEL_TRACING_SETTINGS } from '../src/shared/otel-tracing.js'

  const { Story } = defineMeta({
    title: 'Settings/ConnectionSettings', component: ConnectionSettings, render: template,
    args: {
      provider: 'llm-pi-ai', baseUrl: '', apiKey: '', clearApiKey: false, sandboxMode: 'workspace-write',
      decisions: { ...DEFAULT_DECISION_SETTINGS, enabled: true, model: 'default' }, decisionApiKey: '', clearDecisionApiKey: false,
      tracing: { ...DEFAULT_OTEL_TRACING_SETTINGS },
      apiKeyConfigured: true, decisionKeyConfigured: false, skillPickerEnabled: true, settingsRestarting: false,
      onSave: fn(), onStatus: fn(),
    },
  })
</script>

{#snippet template(args: ComponentProps<typeof ConnectionSettings>)}
  <Preview {args} />
{/snippet}

<Story name="Main connection" />
<Story name="Direct DeepSeek route" args={{ provider: 'deepseek-official' }} />
<Story name="Skills disabled" args={{ skillPickerEnabled: false }} />
<Story name="Applying settings" args={{ settingsRestarting: true }} />
