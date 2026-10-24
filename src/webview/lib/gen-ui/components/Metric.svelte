<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    label: string
    value: string
    delta?: string
    tone?: 'default' | 'success' | 'danger'
  }> {}

  let { props }: Props = $props()

  const valueColor = $derived(({ default: 'var(--foreground)', success: 'var(--tool-completed-border)', danger: 'var(--tool-failed-border)' })[props.tone ?? 'default'])
</script>

<div class="flex min-w-0 flex-col gap-[1px]">
  <span class="text-[10px] uppercase tracking-[0.04em] text-[var(--muted-foreground)] break-words">{props.label}</span>
  <span class="text-[15px] leading-[1.15] font-semibold break-words" style="color: {valueColor}">{props.value}</span>
  {#if props.delta}
    <span class="text-[10px] text-[var(--muted-foreground)] break-words">{props.delta}</span>
  {/if}
</div>
