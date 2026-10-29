<script lang="ts">
  import { ChevronDown, FileDiff } from '@lucide/svelte'
  import type { CodeChange } from '../types.js'

  interface Props {
    changes: CodeChange[]
    open?: boolean
    variant?: 'summary' | 'drawer'
  }

  let { changes, open = $bindable(false), variant = 'summary' }: Props = $props()
  const variantClass = $derived(variant === 'drawer'
    ? 'relative z-[1] mx-[7px] my-0 flex-none rounded-t-[8px] rounded-b-none border-b-0'
    : 'mx-[7px] mt-0 mb-[14px] rounded-[8px]')

  function changeKindSymbol(kind: CodeChange['kind']): string {
    if (kind === 'created') return 'A'
    if (kind === 'deleted') return 'D'
    if (kind === 'renamed') return 'R'
    return 'M'
  }

  function changeKindLabel(kind: CodeChange['kind']): string {
    if (kind === 'created') return 'created'
    if (kind === 'deleted') return 'deleted'
    if (kind === 'renamed') return 'renamed'
    return 'modified'
  }

  function changeKindColor(kind: CodeChange['kind']): string {
    if (kind === 'created') return 'text-[var(--tool-completed-border)]'
    if (kind === 'deleted') return 'text-[var(--tool-failed-border)]'
    if (kind === 'renamed') return 'text-[var(--thinking-border)]'
    return 'text-[var(--muted-foreground)]'
  }

  const fileLabel = $derived(`${changes.length} ${changes.length === 1 ? 'file' : 'files'}`)
  const additions = $derived(changes.reduce((total, change) => total + change.additions, 0))
  const deletions = $derived(changes.reduce((total, change) => total + change.deletions, 0))
</script>

<section
  class={`animate-changes-panel-in overflow-hidden border border-[var(--border)] bg-[var(--composer)] motion-reduce:animate-none ${variantClass}`}
  aria-label={variant === 'drawer' ? 'Agent changes' : 'Agent changes summary'}
>
  <button
    class="btn flex min-h-[29px] w-full items-center gap-[8px] border-0 bg-transparent px-[8px] py-[6px] text-left text-[var(--muted-foreground)]! hover:enabled:bg-[var(--secondary)] hover:enabled:text-[var(--foreground)]!"
    data-variant="ghost"
    type="button"
    aria-expanded={open}
    onclick={() => { open = !open }}
  >
    <span class="inline-flex flex-none items-center gap-[5px] text-[10px] font-semibold text-[var(--foreground)]">
      <FileDiff size={13} strokeWidth={1.8} />
      <span>Changes</span>
    </span>
    <span class="min-w-0 truncate text-[10px] text-[var(--muted-foreground)]">
      {additions === 0 && deletions === 0 ? `${fileLabel} changed` : `${fileLabel} · `}
      {#if additions > 0}<span class="text-[var(--tool-completed-border)]">+{additions}</span>{/if}
      {#if additions > 0 && deletions > 0}<span aria-hidden="true"> </span>{/if}
      {#if deletions > 0}<span class="text-[var(--tool-failed-border)]">−{deletions}</span>{/if}
    </span>
    <ChevronDown class={`ml-auto flex-none transition-transform duration-[180ms] ease-[ease] motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} size={13} strokeWidth={1.8} />
  </button>
  <div class={`grid [transition:grid-template-rows_.2s_ease,opacity_.15s_ease] motion-reduce:transition-none ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
    <div class="min-h-0 overflow-hidden">
      <div class="grid max-h-[180px] gap-[2px] overflow-auto px-[8px] pt-0 pb-[8px]">
        {#each changes as change (change.path)}
          <div class="flex min-w-0 items-center gap-[7px] border-t border-[var(--border)] px-0 py-[5px] text-[10px]">
            <span
              class={`inline-grid h-[16px] w-[16px] flex-none place-items-center rounded-[3px] bg-[var(--secondary)] text-[9px] font-bold [font-family:var(--vscode-editor-font-family,monospace)] ${changeKindColor(change.kind)}`}
              title={changeKindLabel(change.kind)}
            >{changeKindSymbol(change.kind)}</span>
            <div class="grid min-w-0 flex-1 gap-[2px]">
              <span class="min-w-0 truncate text-[var(--foreground)]" title={change.path}>{change.path}</span>
              {#if change.oldPath}<small class="truncate text-[9px] text-[#6f777f]">from {change.oldPath}</small>{/if}
            </div>
            <span class="inline-flex flex-none gap-[5px] text-[9px] text-[var(--muted-foreground)] [font-family:var(--vscode-editor-font-family,monospace)]">
              {#if change.additions > 0}<span class="text-[var(--tool-completed-border)]">+{change.additions}</span>{/if}
              {#if change.deletions > 0}<span class="text-[var(--tool-failed-border)]">−{change.deletions}</span>{/if}
              {#if change.additions === 0 && change.deletions === 0}<span>{changeKindLabel(change.kind)}</span>{/if}
            </span>
          </div>
        {/each}
      </div>
    </div>
  </div>
</section>
