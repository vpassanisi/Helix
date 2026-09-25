<script lang="ts">
  import { Plus, Settings2 } from '@lucide/svelte'
  import type { RuntimeState } from '../types.js'

  interface Props {
    runtimeState: RuntimeState
    onNewSession: () => void
    onOpenSettings: () => void
  }

  // The status-dot halo color tracks the dot color per state. `starting` keeps
  // the base gray halo from the original CSS and only swaps the fill + pulse.
  let { runtimeState, onNewSession, onOpenSettings }: Props = $props()

  const dotClass = $derived(
    runtimeState === 'ready'
      ? 'bg-[#d5d5d5] shadow-[0_0_0_3px_#d5d5d522]'
      : runtimeState === 'starting'
        ? 'bg-[#a3a3a3] shadow-[0_0_0_3px_#68686822] animate-pulse'
        : runtimeState === 'error'
          ? 'bg-[var(--destructive)] shadow-[0_0_0_3px_#ef444422]'
          : 'bg-[#686868] shadow-[0_0_0_3px_#68686822]',
  )
</script>

<header class="p-1 px-3 border-b border-[var(--border)]">
  <div class="relative flex min-h-[27px] items-center justify-start gap-2.5">
    <div class="flex min-w-0 items-center gap-[9px]">
      <h1 class="text-[17px] leading-[1.05] tracking-[-.035em] font-[650] text-[var(--thinking-border)]">Helix</h1>
      <div class="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)] whitespace-nowrap">
        <span class={`size-1.5 rounded-full ${dotClass}`}></span>
        <span>{runtimeState}</span>
      </div>
    </div>

    <div class="absolute top-1/2 right-0 flex items-center gap-1 -translate-y-1/2">
      <button
        type="button"
        title="New session"
        aria-label="New session"
        onclick={onNewSession}
        class="btn icon-button"
        data-variant="ghost"
        data-size="icon" >
        <Plus size={15} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        title="Settings"
        aria-label="Settings"
        onclick={onOpenSettings}
        class="btn icon-button"
        data-variant="ghost"
        data-size="icon" >
        <Settings2 size={15} strokeWidth={1.8} />
      </button>
    </div>
  </div>
</header>
