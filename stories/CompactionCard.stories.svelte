<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import CompactionCard from '../src/webview/components/CompactionCard.svelte'
  const entry = { key: 'preview', sessionId: 'preview', kind: 'summary' as const, status: 'completed' as const, historyItems: 24, shadowedTokens: 18000 }
  const { Story } = defineMeta({ title: 'Chat/CompactionCard', component: CompactionCard, args: { entry, subagent: false } })
</script>

<Story name="Completed" />
<Story name="Running" args={{ entry: { ...entry, status: 'running' } }} />
<Story name="Failed" args={{ entry: { ...entry, status: 'failed', error: 'The summary could not be created.' } }} />
<Story name="Interrupted" args={{ entry: { ...entry, status: 'interrupted' } }} />
<Story name="Pruned" args={{ entry: { ...entry, kind: 'prune', pruneCount: 3 } }} />
<Story name="Subagent" args={{ subagent: true }} />
