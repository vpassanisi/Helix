<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    label: string
    variant?: 'primary' | 'secondary' | 'danger'
    disabled?: boolean
  }> {}

  let { props, emit }: Props = $props()

  // Basecoat names its destructive variant, and "danger" is the word a model
  // reaches for, so the catalog speaks "danger" and the markup translates.
  const variant = $derived(props.variant === 'danger' ? 'destructive' : props.variant === 'secondary' ? 'secondary' : 'primary')
</script>

<button
  class="btn self-start"
  data-size="sm"
  data-variant={variant}
  disabled={props.disabled === true}
  onclick={() => emit('press')}
>
  {props.label}
</button>

<style>
  .btn {
    max-width: 100%;
    white-space: normal;
    text-align: start;
  }

  /* Basecoat paints its variants inside `@layer components`, and app.css sets
     `button { color: inherit }` outside every layer. An unlayered rule beats a
     layered one whatever its specificity, so the inherited near-white foreground
     won over `--primary-foreground` and a primary button drew near-white text on
     the near-white `--primary` fill. The card states its own tokens instead, in
     the same unlayered sheet the sidebar's rules live in. */
  .btn[data-variant='primary'] {
    border-color: transparent;
    background: var(--brand-gold);
    color: var(--primary-foreground);
  }

  .btn[data-variant='primary']:hover:not(:disabled) {
    border-color: transparent;
    background: color-mix(in srgb, var(--brand-gold) 86%, var(--foreground));
  }

  .btn[data-variant='secondary'] {
    border-color: var(--border);
    background: var(--secondary);
    color: var(--secondary-foreground);
  }

  .btn[data-variant='secondary']:hover:not(:disabled) {
    border-color: #626262;
    background: var(--accent);
  }

  .btn[data-variant='destructive'] {
    border-color: transparent;
    background: var(--tool-failed-border);
    color: var(--composer);
  }

  .btn[data-variant='destructive']:hover:not(:disabled) {
    border-color: transparent;
    background: color-mix(in srgb, var(--tool-failed-border) 86%, var(--foreground));
  }
</style>
