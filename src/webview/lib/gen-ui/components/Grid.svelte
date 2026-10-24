<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    columns: number
    gap?: 'none' | 'sm' | 'md' | 'lg'
  }> {
    children?: Snippet
  }

  let { props, children }: Props = $props()

  // A sidebar is narrow: ask for four columns and you get two, not a squeezed row.
  const columns = $derived(Math.max(1, Math.min(Math.round(props.columns ?? 1), 3)))
  const gap = $derived(({ none: 'gap-0', sm: 'gap-1', md: 'gap-2', lg: 'gap-3' })[props.gap ?? 'md'])
</script>

<div class="grid min-w-0 {gap}" style="grid-template-columns: repeat({columns}, minmax(0, 1fr))">
  {#if children}{@render children()}{/if}
</div>
