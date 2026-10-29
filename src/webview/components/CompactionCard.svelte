<script lang="ts">
  import { CircleAlert } from '@lucide/svelte'
  import { compactionDetail, compactionTitle, type CompactionEntry } from '../../shared/compaction-history.js'

  let { entry, subagent = false }: { entry: CompactionEntry; subagent?: boolean } = $props()
  const active = $derived(entry.status === 'running')
  const compactionColor = $derived(entry.status === 'running' ? 'var(--brand-gold)'
    : entry.status === 'failed' ? 'var(--tool-failed-border)'
      : entry.status === 'interrupted' ? 'var(--muted-foreground)' : 'var(--thinking-border)')
</script>

<!-- A mode-rule-style marker: the line reaches both edges and fades out, breaking for the
     status label; the detail sits on its own line below. While compaction is running the line pulses,
     and a failed marker keeps a small alert icon. -->
<div
  class="grid gap-[3px] px-2.5 text-[var(--compaction-color,var(--thinking-border))]"
  style={`--compaction-color: ${compactionColor}`}
  class:active
  role="status"
  aria-live="polite"
  aria-busy={active}
>
  <div
    class="flex items-center justify-center gap-[9px] text-[9px] font-semibold tracking-[.14em] whitespace-nowrap uppercase before:content-[''] before:flex-1 before:min-w-3 before:h-px before:bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--compaction-color)_42%,var(--border)))] after:content-[''] after:flex-1 after:min-w-3 after:h-px after:bg-[linear-gradient(90deg,color-mix(in_srgb,var(--compaction-color)_42%,var(--border)),transparent)] [.active_&]:before:animate-compaction-rule-pulse [.active_&]:after:animate-compaction-rule-pulse motion-reduce:before:animate-none motion-reduce:after:animate-none"
  >
    {#if entry.status === 'failed'}
      <CircleAlert class="text-[var(--compaction-color)]" size={14} strokeWidth={1.8} aria-hidden="true" />
    {/if}
    <span>{compactionTitle(entry)}</span>
    {#if subagent}<span class="font-normal text-[var(--muted-foreground)]">Subagent</span>{/if}
  </div>
  <span class="text-[10px] font-normal tracking-0 leading-[1.5] text-center text-[var(--muted-foreground)] [overflow-wrap:anywhere]">{compactionDetail(entry)}</span>
</div>
