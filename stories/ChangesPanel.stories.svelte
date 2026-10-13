<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import type { ComponentProps } from 'svelte'
  import ChangesPanel from '../src/webview/components/ChangesPanel.svelte'
  import { changes } from './fixtures.js'
  const { Story } = defineMeta({
    title: 'Chat/ChangesPanel', component: ChangesPanel, render: template,
    args: { changes, open: true, variant: 'summary' },
    argTypes: { variant: { control: 'select', options: ['summary', 'drawer'] }, open: { control: 'boolean' } },
  })
</script>

{#snippet template(args: ComponentProps<typeof ChangesPanel>)}
  <ChangesPanel {...args} />
  {#if args.variant === 'drawer'}<div class="relative rounded-[8px] border border-[var(--border)] bg-[var(--composer)]"><textarea class="textarea min-h-[48px] max-h-[180px] resize-none rounded-none border-0 bg-transparent" placeholder="Ask about your code..." aria-label="Preview composer" rows="2" disabled></textarea></div>{/if}
{/snippet}

<Story name="Summary expanded" />
<Story name="Summary collapsed" args={{ open: false }} />
<Story name="Drawer expanded" args={{ variant: 'drawer' }} />
<Story name="Drawer collapsed" args={{ variant: 'drawer', open: false }} />
<Story name="No line counts" args={{ changes: [{ path: 'src/webview/App.svelte', kind: 'modified', additions: 0, deletions: 0 }] }} />
