<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    text: string
    level?: 'h1' | 'h2' | 'h3'
  }> {}

  let { props }: Props = $props()

  const size = $derived(props.level === 'h1' ? 'text-[14px]' : props.level === 'h3' ? 'text-[11px] uppercase tracking-[0.04em]' : 'text-[13px]')
</script>

{#if props.level === 'h1'}
  <h1 class="{size} font-semibold text-[var(--foreground)] break-words">{props.text}</h1>
{:else if props.level === 'h3'}
  <h3 class="{size} font-semibold text-[var(--muted-foreground)] break-words">{props.text}</h3>
{:else}
  <h2 class="{size} font-semibold text-[var(--foreground)] break-words">{props.text}</h2>
{/if}
