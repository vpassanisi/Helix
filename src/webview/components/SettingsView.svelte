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
</script>

<section class="settings-view" aria-labelledby="settings-heading">
  <div class="settings-heading">
    <button class="btn icon-button" data-variant="ghost" data-size="icon" type="button" aria-label="Back to chat" title="Back to chat" onclick={onClose}>
      <ArrowLeft size={15} strokeWidth={1.8} />
    </button>
    <div>
      <h2 id="settings-heading">{title}</h2>
    </div>
  </div>

  {@render children()}

  <p class:success={tone === 'success'} class:warning={tone === 'warning'} class="settings-status" role="status">{status}</p>
</section>
