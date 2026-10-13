<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import McpSettings from '../src/webview/components/McpSettings.svelte'
  import Preview from './previews/McpSettingsPreview.svelte'
  import { mcpServers } from './fixtures.js'

  const { Story } = defineMeta({
    title: 'Settings/McpSettings', component: McpSettings, render: template,
    args: { mcpServers, mcpSaving: false, settingsRestarting: false, onSave: fn() },
  })
</script>

{#snippet template(args: ComponentProps<typeof McpSettings>)}
  <Preview {args} />
{/snippet}

<Story name="Populated" />
<Story name="Empty" args={{ mcpServers: [] }} />
<Story name="Applying" args={{ mcpSaving: true, settingsRestarting: true }} />
