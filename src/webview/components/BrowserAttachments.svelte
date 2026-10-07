<script lang="ts">
  import { X } from '@lucide/svelte'
  import type { BrowserElementContext } from '../../shared/browser-context.js'
  let { attachments, disabled, onremove }: {
    attachments: BrowserElementContext[]
    disabled: boolean
    onremove: (id: string) => void
  } = $props()
</script>

<div class="browser-attachments" aria-label="Browser element attachments">
  {#each attachments as attachment (attachment.id)}
    <span class="context-chip browser-attachment" aria-label={`Browser element ${attachment.label}`}>
      <span class="browser-attachment-label">{attachment.label}</span>
      <span data-tooltip="Remove browser element">
        <button class="btn" data-variant="ghost" data-size="icon-xs" type="button" aria-label={`Remove ${attachment.label}`} {disabled} onclick={() => onremove(attachment.id)}><X size={12} /></button>
      </span>
    </span>
  {/each}
</div>

<style>
  .browser-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .browser-attachment { min-width: 0; margin-bottom: 0; font-size: 10px; }
  .browser-attachment-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #cfcfcf; }
  .browser-attachment > span:last-child { display: flex; flex: 0 0 auto; }
  .browser-attachment button { width: 18px; height: 18px; padding: 0; }
</style>
