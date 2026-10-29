<script lang="ts">
  import { MousePointer2, X } from '@lucide/svelte'
  import type { BrowserElementContext } from '../../shared/browser-context.js'
  let { attachments, disabled, onremove }: {
    attachments: BrowserElementContext[]
    disabled: boolean
    onremove: (id: string) => void
  } = $props()
</script>

<div class="flex flex-wrap gap-[6px] mb-[8px]" aria-label="Browser element attachments">
  {#each attachments as attachment (attachment.id)}
    <span class="flex w-fit max-w-full items-center gap-[8px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--composer)] px-[6px] py-[4px] text-[11px] text-[var(--muted-foreground)]" aria-label={`Browser element ${attachment.label}`}>
      <MousePointer2 size={14} strokeWidth={1.7} />
      <span class="min-w-0 flex-[0_1_auto] truncate text-[var(--foreground)]">{attachment.label}</span>
      <button class="btn h-[24px] w-[24px] p-0" data-variant="ghost" data-size="icon" type="button" aria-label={`Remove ${attachment.label}`} title={`Remove ${attachment.label}`} {disabled} onclick={() => onremove(attachment.id)}><X size={14} strokeWidth={1.8} /></button>
    </span>
  {/each}
</div>
