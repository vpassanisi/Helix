<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    text: string
    note?: string
    tone?: 'default' | 'muted' | 'danger'
  }> {}

  let { props }: Props = $props()

  const color = $derived(({ default: 'var(--foreground)', muted: 'var(--muted-foreground)', danger: 'var(--tool-failed-border)' })[props.tone ?? 'default'])
</script>

<li class="flex min-w-0 flex-col gap-[1px] py-[2px]" style="color: {color}">
  <span class="text-[12px] leading-[1.45] break-words">{props.text}</span>
  {#if props.note}
    <span class="text-[10px] leading-[1.4] text-[var(--muted-foreground)] break-words">{props.note}</span>
  {/if}
</li>
