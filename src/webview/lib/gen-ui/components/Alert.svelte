<script lang="ts">
  import { CircleCheck, Info, TriangleAlert } from '@lucide/svelte'
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    text: string
    title?: string
    tone?: 'info' | 'success' | 'warning' | 'danger'
  }> {}

  let { props }: Props = $props()

  const tone = $derived(props.tone ?? 'info')
  const color = $derived(({ info: 'var(--thinking-border)', success: 'var(--tool-completed-border)', warning: 'var(--brand-gold)', danger: 'var(--tool-failed-border)' })[tone])
</script>

<div class="alert gen-ui-alert" role="alert" style="--gen-ui-tone: {color}">
  {#if tone === 'success'}
    <span class="gen-ui-alert__icon"><CircleCheck size={13} strokeWidth={1.8} aria-hidden="true" /></span>
  {:else if tone === 'info'}
    <span class="gen-ui-alert__icon"><Info size={13} strokeWidth={1.8} aria-hidden="true" /></span>
  {:else}
    <span class="gen-ui-alert__icon"><TriangleAlert size={13} strokeWidth={1.8} aria-hidden="true" /></span>
  {/if}
  {#if props.title}<strong data-title>{props.title}</strong>{/if}
  <section><p>{props.text}</p></section>
</div>

<style>
  .gen-ui-alert {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 2px 8px;
    border: 1px solid color-mix(in srgb, var(--gen-ui-tone) 35%, transparent);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--gen-ui-tone) 10%, transparent);
    padding: 7px 9px;
    font-size: 12px;
    line-height: 1.45;
  }

  .gen-ui-alert__icon {
    display: flex;
    grid-row: span 2;
    margin-top: 2px;
    color: var(--gen-ui-tone);
  }

  .gen-ui-alert > strong {
    font-size: 12px;
    font-weight: 600;
    color: var(--gen-ui-tone);
  }

  .gen-ui-alert > section {
    display: block;
    min-width: 0;
  }

  .gen-ui-alert > section > p {
    margin: 0;
    color: var(--foreground);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
