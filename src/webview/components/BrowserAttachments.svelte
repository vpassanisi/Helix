<script lang="ts">
  import { X } from '@lucide/svelte'
  import type { BrowserElementContext } from '../../shared/browser-context.js'
  let { attachments, disabled, onremove }: {
    attachments: BrowserElementContext[]
    disabled: boolean
    onremove: (id: string) => void
  } = $props()
</script>

<div class="flex flex-wrap gap-[6px] mb-2" aria-label="Browser element attachments">
  {#each attachments as attachment (attachment.id)}
    <span class="context-chip min-w-0 mb-0 text-[10px]" aria-label={`Browser element ${attachment.label}`}>
      <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#cfcfcf]">{attachment.label}</span>
      <span class="flex flex-none" data-tooltip="Remove browser element">
        <button class="btn w-[18px] h-[18px] p-0" data-variant="ghost" data-size="icon-xs" type="button" aria-label={`Remove ${attachment.label}`} {disabled} onclick={() => onremove(attachment.id)}><X size={12} /></button>
      </span>
    </span>
  {/each}
</div>
