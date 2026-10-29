<script lang="ts">
  import { Terminal } from '@lucide/svelte'
  import type { CommandAnchor } from '../lib/composer-commands.svelte.js'
  import type { ComposerCommand } from '../../shared/commands.js'

  interface Props {
    items: ComposerCommand[]
    active: number
    anchor: CommandAnchor
    busy?: boolean
    /** Shown when there are no rows: the host's reason, or no match. */
    message?: string
    onpick: (index: number) => void
    onhover: (index: number) => void
  }

  let { items, active, anchor, busy = false, message = 'No command matches that name.', onpick, onhover }: Props = $props()

  /** One stable id per row, so the textarea can name the highlighted one. */
  const rowId = (command: ComposerCommand): string => `composer-command-${command.name}`
</script>

<!-- The mousedown is a focus guard, not an interaction: the rows are the buttons. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="command absolute z-40 [--command-menu-width:min(340px,100%)] w-[var(--command-menu-width)] gap-0.5 p-1 border border-[var(--border)] rounded-lg bg-[var(--popover)] shadow-[0_14px_34px_-14px_rgb(0_0_0/0.7)] animate-command-menu-in motion-reduce:animate-none [&_[role='menuitem'][data-selected='true']]:bg-[var(--accent)] [&_[role='menuitem'][data-selected='true']]:text-[var(--foreground)] [&_[role='menuitem']:hover:not(:disabled)]:bg-[color-mix(in_srgb,var(--accent)_65%,transparent)] [&_[role='menuitem']:disabled]:opacity-50"
  id="composer-command-menu"
  role="group"
  aria-label="Composer commands"
  data-filter="manual"
  style="left: min({anchor.x}px, calc(100% - var(--command-menu-width))); bottom: calc(100% - {anchor.y}px + 10px);"
  onmousedown={(event) => {
    // The draft keeps focus: a row's mousedown must not close the popup before its click lands.
    event.preventDefault()
  }}
>
  <header class="flex items-center gap-[5px] px-[6px] pt-[3px] pb-[4px] text-[var(--muted-foreground)] text-[9px] tracking-[.08em] uppercase">
    <Terminal size={12} strokeWidth={1.8} aria-hidden="true" />
    <span>Commands</span>
    <span class="flex-1 text-right tabular-nums">{items.length}</span>
  </header>
  <div
    class="max-h-[216px] before:px-[6px] before:py-2 before:text-[var(--muted-foreground)] before:text-[10px]"
    role="menu"
    aria-label="Available commands"
    data-empty={message}
  >
    {#each items as command, index (command.name)}
      <button
        class="grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-1.5 border-0 rounded-[5px] bg-transparent px-[6px] py-[5px] text-left text-[10px]"
        id={rowId(command)}
        type="button"
        role="menuitem"
        data-selected={index === active || undefined}
        aria-posinset={index + 1}
        aria-setsize={items.length}
        disabled={busy}
        onclick={() => onpick(index)}
        onmouseenter={() => onhover(index)}
        onfocus={() => onhover(index)}
      >
        <span class="font-semibold whitespace-nowrap text-[var(--brand-gold)]">/{command.name}</span>
        {#if command.hint}<span class="whitespace-nowrap tabular-nums text-[var(--muted-foreground)]">{command.hint}</span>{/if}
        <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--muted-foreground)] [[data-selected]_&]:text-[var(--foreground)]">{command.description}</span>
        {#if index === active}<span class="inline-flex" data-shortcut><kbd class="kbd">Tab</kbd></span>{/if}
      </button>
    {/each}
  </div>
</div>
