<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    text: string
    tone?: 'default' | 'muted' | 'strong'
    size?: 'sm' | 'md'
  }> {}

  let { props }: Props = $props()

  const tone = $derived(props.tone === 'muted'
    ? 'text-[var(--muted-foreground)]'
    : props.tone === 'strong' ? 'text-[var(--foreground)] font-medium' : 'text-[var(--foreground)]')
</script>

<p class="{props.size === 'sm' ? 'text-[11px]' : 'text-[12px]'} leading-[1.45] break-words whitespace-pre-wrap {tone}">{props.text}</p>
