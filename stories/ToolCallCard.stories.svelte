<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import ToolCallCard from '../src/webview/components/ToolCallCard.svelte'
  import Preview from './previews/ToolCallPreview.svelte'
  import { tool } from './fixtures.js'

  const { Story } = defineMeta({
    title: 'Chat/ToolCallCard', component: ToolCallCard, render: template,
    args: { tool, onapprove: fn() },
  })
</script>

{#snippet template(args: ComponentProps<typeof ToolCallCard>)}
  <Preview {args} />
{/snippet}

<Story name="Preparing" args={{ tool: { ...tool, status: 'preparing', result: undefined, meta: undefined } }} />
<Story name="Running" args={{ tool: { ...tool, status: 'running', result: undefined, meta: undefined } }} />
<Story name="Completed" />
<Story name="Error" args={{ tool: { ...tool, status: 'error', result: undefined, error: 'The file could not be read.' } }} />
<Story name="Awaiting approval" args={{ tool: { ...tool, status: 'running', result: undefined, approval: { requestId: 'approval', status: 'pending', reason: 'Allow this command to run in the workspace?' } } }} />
<Story name="Sending approval" args={{ tool: { ...tool, status: 'running', result: undefined, approval: { requestId: 'approval', status: 'pending', decisionPending: true } } }} />
