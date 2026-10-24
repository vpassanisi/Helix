<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{ ordered?: boolean }> {
    children?: Snippet
  }

  let { props, children }: Props = $props()
</script>

{#if props.ordered}
  <ol class="gen-ui-list">{#if children}{@render children()}{/if}</ol>
{:else}
  <ul class="gen-ui-list">{#if children}{@render children()}{/if}</ul>
{/if}

<style>
  .gen-ui-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }

  ol.gen-ui-list {
    list-style: decimal;
    padding-inline-start: 18px;
  }
</style>
