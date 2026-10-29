<script lang="ts">
  import { ArrowLeft } from '@lucide/svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    status: string
    tone: 'success' | 'warning' | ''
    onClose: () => void
    children: Snippet
  }

  let { title, status, tone, onClose, children }: Props = $props()

  /** The status line keeps its height; a save outcome tints the text. */
  const statusClass = $derived(
    `flex-none min-h-[30px] mt-3.5 text-[10px] leading-[1.45] ${
      tone === 'success' ? 'text-[#cfcfcf]' : tone === 'warning' ? 'text-[#d0d0d0]' : 'text-[var(--muted-foreground)]'
    }`,
  )
</script>

<section class="flex flex-1 min-h-0 flex-col overflow-auto px-3.5 pb-5" aria-labelledby="settings-heading">
  <div class="sticky top-0 z-20 flex flex-none items-center gap-[9px] mx-[-14px] mb-[18px] border-b border-[var(--border)] bg-[var(--background)] px-3.5 py-1 [&_h2]:text-[16px] [&_h2]:tracking-[-.025em]">
    <button class="btn h-[27px] w-[28px] p-0" data-variant="ghost" data-size="icon" type="button" aria-label="Back to chat" title="Back to chat" onclick={onClose}>
      <ArrowLeft size={15} strokeWidth={1.8} />
    </button>
    <div>
      <h2 id="settings-heading">{title}</h2>
    </div>
  </div>

  {@render children()}

  <p class={statusClass} role="status">{status}</p>
</section>
