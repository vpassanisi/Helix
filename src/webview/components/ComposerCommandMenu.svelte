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
  class="command composer-command-menu absolute z-40"
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
  <header class="composer-command-head">
    <Terminal size={12} strokeWidth={1.8} aria-hidden="true" />
    <span>Commands</span>
    <span class="composer-command-count">{items.length}</span>
  </header>
  <div
    class="composer-command-list"
    role="menu"
    aria-label="Available commands"
    data-empty={message}
  >
    {#each items as command, index (command.name)}
      <button
        class="composer-command-row"
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
        <span class="composer-command-name">/{command.name}</span>
        {#if command.hint}<span class="composer-command-hint">{command.hint}</span>{/if}
        <span class="composer-command-description">{command.description}</span>
        {#if index === active}<span class="composer-command-key" data-shortcut><kbd class="kbd">Tab</kbd></span>{/if}
      </button>
    {/each}
  </div>
</div>
