<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    spacing?: 'sm' | 'md' | 'lg'
  }> {}

  let { props }: Props = $props()

  const margin = $derived(({ sm: 'my-1', md: 'my-2', lg: 'my-3' })[props.spacing ?? 'sm'])
</script>

<hr class="w-full border-0 border-t border-t-[var(--border)] {margin}" />
