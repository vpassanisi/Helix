<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    label: string
    value: number
    max?: number
    showValue?: boolean
  }> {}

  let { props }: Props = $props()

  const max = $derived(props.max && props.max > 0 ? props.max : 100)
  const percent = $derived(Math.max(0, Math.min(100, Math.round(((props.value ?? 0) / max) * 100))))
</script>

<div class="flex min-w-0 flex-col gap-[3px]">
  <div class="flex min-w-0 items-baseline justify-between gap-2">
    <span class="min-w-0 truncate text-[11px] text-[var(--foreground)]">{props.label}</span>
    {#if props.showValue !== false}
      <span class="flex-none text-[10px] tabular-nums text-[var(--muted-foreground)]">{props.value}/{max}</span>
    {/if}
  </div>
  <div class="progress" role="progressbar" aria-label={props.label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={props.value}>
    <span style="width: {percent}%"></span>
  </div>
</div>

<style>
  .progress {
    height: 4px;
    border-radius: 999px;
    background: var(--muted);
  }

  .progress > span {
    display: block;
    border-radius: inherit;
    background: var(--brand-gold);
  }
</style>
