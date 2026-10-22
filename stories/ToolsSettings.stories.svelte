<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import ToolsSettings from '../src/webview/components/ToolsSettings.svelte'
  import Preview from './previews/ToolsSettingsPreview.svelte'

  const groupsOff = ['tool-subagent-fork', 'tool-workflow', 'tool-jobs']

  const { Story } = defineMeta({
    title: 'Settings/ToolsSettings', component: ToolsSettings, render: template,
    args: { disabled: [], saved: [], saving: false, onSave: fn(), onDiscard: fn() },
  })
</script>

{#snippet template(args: ComponentProps<typeof ToolsSettings>)}
  <Preview {args} />
{/snippet}

<Story name="All tools on" />
<Story name="Agent tools off" args={{ disabled: groupsOff, saved: groupsOff }} />
<Story name="Unsaved changes" args={{ disabled: ['tool-fs-search'], saved: [] }} />
<Story name="Saving" args={{ disabled: groupsOff, saved: groupsOff, saving: true }} />
