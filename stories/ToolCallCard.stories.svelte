<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import ToolCallCard from '../src/webview/components/ToolCallCard.svelte'
  import Preview from './previews/ToolCallPreview.svelte'
  import { bashTerminalTool, bashTool, editTool, globTool, grepTool, readImageTool, readTool, readToolUnpresented, tool, writeTool } from './fixtures.js'

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
<Story name="Bash" args={{ tool: bashTool }} />
<Story name="Presenter title" args={{ tool: readTool }} />
<Story name="Presenter summary wins" args={{ tool: bashTerminalTool }} />
<Story name="No presenter" args={{ tool: readToolUnpresented }} />
<Story name="Write" args={{ tool: writeTool }} />
<Story name="Edit" args={{ tool: editTool }} />
<Story name="Read image" args={{ tool: readImageTool }} />
<Story name="Glob" args={{ tool: globTool }} />
<Story name="Grep" args={{ tool: grepTool }} />
<Story name="No description" args={{ tool: { ...tool, name: 'read_file', arguments: '{"path":"src/webview/components/ToolCallCard.svelte"}', description: undefined, result: '<script lang="ts">\n  import type { ToolCallView } from \'../types.js\'', meta: 'Finished in 0.2s' } }} />
<Story name="Error" args={{ tool: { ...tool, status: 'error', result: undefined, error: 'Command failed with exit code 1.' } }} />
<Story name="Awaiting approval" args={{ tool: { ...tool, status: 'running', result: undefined, approval: { requestId: 'approval', status: 'pending', reason: 'Allow this command to run in the workspace?' } } }} />
<Story name="Sending approval" args={{ tool: { ...tool, status: 'running', result: undefined, approval: { requestId: 'approval', status: 'pending', decisionPending: true } } }} />
