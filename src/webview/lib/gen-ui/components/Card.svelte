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

  const tone = $derived(props.tone ?? 'default')
</script>

<div class="card card--gen-ui" data-size="sm" data-tone={tone}>
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
  /* The card always renders inside the gen-ui card, which already carries the
     border, background and shadow. Keep the surface flat: only the tone rule
     marks the block. */
  .card.card--gen-ui {
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .card--gen-ui[data-tone='accent'] {
    border-left: 2px solid var(--brand-gold);
  }

  .card--gen-ui[data-tone='danger'] {
    border-left: 2px solid var(--tool-failed-border);
  }

  .card__body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
</style>
