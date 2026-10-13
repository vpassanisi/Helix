<script lang="ts">
  import { Archive, CircleAlert, LoaderCircle, Scissors, Square } from '@lucide/svelte'
  import { compactionDetail, compactionTitle, type CompactionEntry } from '../../shared/compaction-history.js'

  let { entry, subagent = false }: { entry: CompactionEntry; subagent?: boolean } = $props()
  const active = $derived(entry.status === 'running')
  const compactionColor = $derived(entry.status === 'running' ? 'var(--brand-gold)'
    : entry.status === 'failed' ? 'var(--tool-failed-border)'
      : entry.status === 'interrupted' ? 'var(--muted-foreground)' : 'var(--thinking-border)')
</script>

<div class="alert compaction-card relative mx-[10px] my-0 w-[calc(100%_-_20px)] min-w-0 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--compaction-color)_24%,var(--border))] bg-[color-mix(in_srgb,var(--compaction-color)_4%,var(--card))] px-3 py-[11px] shadow-none" style={`--compaction-color: ${compactionColor}`} class:active class:failed={entry.status === 'failed'} class:interrupted={entry.status === 'interrupted'}
  data-variant={entry.status === 'failed' ? 'destructive' : undefined} role="status" aria-live="polite" aria-busy={active}>
  {#if active}
    <LoaderCircle class="compaction-spinner self-center translate-x-0 translate-y-0 h-4 w-4 text-[var(--compaction-color)] animate-[spin_1.4s_linear_infinite] motion-reduce:animate-none" size={16} strokeWidth={1.7} aria-hidden="true" />
  {:else if entry.status === 'failed'}
    <CircleAlert class="self-center translate-x-0 translate-y-0 h-4 w-4 text-[var(--compaction-color)]" size={16} strokeWidth={1.7} aria-hidden="true" />
  {:else if entry.status === 'interrupted'}
    <Square class="self-center translate-x-0 translate-y-0 h-4 w-4 text-[var(--compaction-color)]" size={16} strokeWidth={1.7} aria-hidden="true" />
  {:else if entry.kind === 'prune'}
    <Scissors class="self-center translate-x-0 translate-y-0 h-4 w-4 text-[var(--compaction-color)]" size={16} strokeWidth={1.7} aria-hidden="true" />
  {:else}
    <Archive class="self-center translate-x-0 translate-y-0 h-4 w-4 text-[var(--compaction-color)]" size={16} strokeWidth={1.7} aria-hidden="true" />
  {/if}
  <h2 class="flex flex-wrap items-center gap-[7px] text-[11px] font-semibold text-[var(--compaction-color)]">
    <span>{compactionTitle(entry)}</span>
    {#if subagent}<span class="text-[9px] font-normal text-[var(--muted-foreground)]">Subagent</span>{/if}
  </h2>
  <section class="text-[10px] leading-[1.5] text-[var(--muted-foreground)] [overflow-wrap:anywhere]">{compactionDetail(entry)}</section>
</div>
