<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import RequestPreviewPanel from '../src/webview/components/RequestPreviewPanel.svelte'
  import Preview from './previews/RequestPreview.svelte'
  import { requestPreview } from './fixtures.js'

  const { Story } = defineMeta({
    title: 'Settings/RequestPreviewPanel', component: RequestPreviewPanel, render: template,
    args: { showRawJson: false, state: 'success', preview: requestPreview, error: '', onCancel: fn() },
  })
</script>

{#snippet template(args: ComponentProps<typeof RequestPreviewPanel>)}
  <Preview {args} />
{/snippet}

<Story name="Readable result" />
<Story name="Raw JSON" args={{ showRawJson: true }} />
<Story name="Idle" args={{ state: 'idle', preview: undefined }} />
<Story name="Loading" args={{ state: 'loading', preview: undefined }} />
<Story name="Error" args={{ state: 'error', preview: undefined, error: 'The preview request could not be assembled.' }} />
<Story name="Cancelled" args={{ state: 'cancelled', preview: undefined }} />
<Story name="No tools" args={{ preview: { ...requestPreview, request: { ...requestPreview.request, tools: [] } } }} />
