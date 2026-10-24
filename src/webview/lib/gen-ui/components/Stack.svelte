<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    direction?: 'vertical' | 'horizontal'
    gap?: 'none' | 'sm' | 'md' | 'lg'
    align?: 'start' | 'center' | 'end' | 'stretch'
  }> {
    children?: Snippet
  }

  let { props, children }: Props = $props()

  const gap = $derived(({ none: 'gap-0', sm: 'gap-1', md: 'gap-2', lg: 'gap-3' })[props.gap ?? 'md'])
  const align = $derived(({ start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch' })[props.align ?? 'stretch'])
</script>

<div class="flex flex-col min-w-0 {props.direction === 'horizontal' ? 'flex-row flex-wrap' : ''} {gap} {align}">
  {#if children}{@render children()}{/if}
</div>
