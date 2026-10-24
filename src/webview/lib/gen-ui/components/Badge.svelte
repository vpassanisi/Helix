<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    label: string
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
  }> {}

  let { props }: Props = $props()

  // Basecoat's badge carries the shape; the tones reuse Helix's own status
  // colours, so a card and a tool row say "failed" in the same red.
  const toneClass = $derived(({ neutral: 'badge--neutral', info: 'badge--info', success: 'badge--success', warning: 'badge--warning', danger: 'badge--danger' })[props.tone ?? 'neutral'])
</script>

<span class="badge {toneClass}">{props.label}</span>

<style>
  .badge {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 7px;
    font-size: 10px;
    line-height: 1.5;
    font-weight: 500;
  }

  .badge--neutral {
    color: var(--muted-foreground);
    background: var(--secondary);
  }

  .badge--info {
    border-color: color-mix(in srgb, var(--thinking-border) 45%, transparent);
    color: var(--thinking-border);
    background: color-mix(in srgb, var(--thinking-border) 12%, transparent);
  }

  .badge--success {
    border-color: color-mix(in srgb, var(--tool-completed-border) 45%, transparent);
    color: var(--tool-completed-border);
    background: color-mix(in srgb, var(--tool-completed-border) 12%, transparent);
  }

  .badge--warning {
    border-color: color-mix(in srgb, var(--brand-gold) 45%, transparent);
    color: var(--brand-gold);
    background: color-mix(in srgb, var(--brand-gold) 12%, transparent);
  }

  .badge--danger {
    border-color: color-mix(in srgb, var(--tool-failed-border) 45%, transparent);
    color: var(--tool-failed-border);
    background: color-mix(in srgb, var(--tool-failed-border) 12%, transparent);
  }
</style>
