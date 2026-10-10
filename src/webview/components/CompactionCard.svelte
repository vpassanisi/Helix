<script lang="ts">
  import { Archive, CircleAlert, CircleCheck, LoaderCircle, Scissors, Square } from '@lucide/svelte'
  import { compactionDetail, compactionTitle, type CompactionEntry } from '../../shared/compaction-history.js'

  let { entry, subagent = false }: { entry: CompactionEntry; subagent?: boolean } = $props()
  const active = $derived(entry.status === 'running')
</script>

<div class="alert compaction-card" class:active class:failed={entry.status === 'failed'} class:interrupted={entry.status === 'interrupted'}
  data-variant={entry.status === 'failed' ? 'destructive' : undefined} role="status" aria-live="polite" aria-busy={active}>
  {#if active}
    <LoaderCircle class="compaction-spinner" size={16} strokeWidth={1.7} aria-hidden="true" />
  {:else if entry.status === 'failed'}
    <CircleAlert size={16} strokeWidth={1.7} aria-hidden="true" />
  {:else if entry.status === 'interrupted'}
    <Square size={16} strokeWidth={1.7} aria-hidden="true" />
  {:else if entry.kind === 'prune'}
    <Scissors size={16} strokeWidth={1.7} aria-hidden="true" />
  {:else}
    <Archive size={16} strokeWidth={1.7} aria-hidden="true" />
  {/if}
  <h2>
    <span>{compactionTitle(entry)}</span>
    {#if subagent}<span class="compaction-scope">Subagent</span>{/if}
    {#if entry.status === 'completed'}<CircleCheck class="compaction-check" size={12} strokeWidth={1.7} aria-hidden="true" />{/if}
  </h2>
  <section>{compactionDetail(entry)}</section>
</div>

<style>
  .compaction-card {
    --compaction-color: var(--thinking-border);
    position: relative;
    width: calc(100% - 20px);
    min-width: 0;
    margin: 0 10px;
    padding: 11px 12px;
    border: 1px solid color-mix(in srgb, var(--compaction-color) 24%, var(--border));
    border-left: 2px solid var(--compaction-color);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--compaction-color) 4%, var(--card));
    box-shadow: none;
  }
  .compaction-card.active { --compaction-color: var(--brand-gold); }
  .compaction-card.failed { --compaction-color: var(--tool-failed-border); }
  .compaction-card.interrupted { --compaction-color: var(--muted-foreground); }
  .compaction-card :global(> svg) { color: var(--compaction-color); width: 16px; height: 16px; }
  .compaction-card h2 { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; color: var(--compaction-color); font-size: 11px; font-weight: 600; }
  .compaction-card section { color: var(--muted-foreground); font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
  .compaction-scope { color: var(--muted-foreground); font-size: 9px; font-weight: 400; }
  .compaction-card :global(.compaction-check) { flex: 0 0 auto; margin-left: auto; }
  .compaction-card :global(.compaction-spinner) { animation: compaction-spin 1.4s linear infinite; }
  .compaction-card.active::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 -2px;
    width: 2px;
    background: linear-gradient(180deg, transparent 20%, #f5dfbd 50%, transparent 80%);
    background-size: 100% 250%;
    animation: compaction-edge 2.8s ease-in-out infinite alternate;
    pointer-events: none;
  }
  @keyframes compaction-spin { to { transform: rotate(360deg); } }
  @keyframes compaction-edge { from { background-position: 0 100%; } to { background-position: 0 0; } }
  @media (prefers-reduced-motion: reduce) {
    .compaction-card :global(.compaction-spinner), .compaction-card.active::after { animation: none; }
  }
</style>
