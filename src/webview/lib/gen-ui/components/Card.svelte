<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    title?: string
    subtitle?: string
    tone?: 'default' | 'accent' | 'danger'
  }> {
    children?: Snippet
  }

  let { props, children }: Props = $props()

  const tone = $derived(props.tone === 'accent'
    ? 'border-l-2 border-l-[var(--brand-gold)]'
    : props.tone === 'danger' ? 'border-l-2 border-l-[var(--tool-failed-border)]' : '')
</script>

<div class="card card--gen-ui {tone}" data-size="sm">
  {#if props.title || props.subtitle}
    <header>
      {#if props.title}<h2 data-title>{props.title}</h2>{/if}
      {#if props.subtitle}<p data-description>{props.subtitle}</p>{/if}
    </header>
  {/if}
  <section class="card__body">
    {#if children}{@render children()}{/if}
  </section>
</div>

<style>
  .card--gen-ui {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
  }

  .card__body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
</style>
