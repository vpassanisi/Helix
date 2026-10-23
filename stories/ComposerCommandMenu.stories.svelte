<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import ComposerCommandMenu from '../src/webview/components/ComposerCommandMenu.svelte'
  import { commands } from './fixtures.js'
  const { Story } = defineMeta({
    title: 'Chat/ComposerCommandMenu',
    component: ComposerCommandMenu,
    render: template,
    args: {
      items: commands, active: 0, anchor: { x: 12, y: 26 }, busy: false,
      onpick: fn(), onhover: fn(),
    },
  })
</script>

{#snippet template(args: ComponentProps<typeof ComposerCommandMenu>)}
  <div class="relative flex min-h-[260px] flex-col justify-end">
    <ComposerCommandMenu {...args} />
    <div class="rounded-[8px] border border-[var(--border)] bg-[var(--composer)] px-[10px] py-[9px] text-[12px]">
      <span style="color: var(--brand-gold);">/comp</span><span style="color: var(--foreground);">act</span>
    </div>
  </div>
{/snippet}

<Story name="All commands" />
<Story name="Filtered" args={{ items: commands.filter((command) => command.name.startsWith('c') || command.name.startsWith('p')), active: 1 }} />
<Story name="Workspace command first" args={{ items: commands.slice(4), active: 0 }} />
<Story name="No match" args={{ items: [], active: -1 }} />
<Story name="Registry unavailable" args={{ items: [], active: -1, message: 'The running Harness has no command registry.' }} />
<Story name="Command running" args={{ busy: true, active: 0 }} />
<Story name="Deep caret" args={{ anchor: { x: 96, y: 84 } }} />
