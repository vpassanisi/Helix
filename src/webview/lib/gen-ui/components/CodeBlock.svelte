<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    code: string
    language?: string
  }> {}

  let { props }: Props = $props()
</script>

<div class="gen-ui-code min-w-0">
  {#if props.language}<span class="gen-ui-code__lang">{props.language}</span>{/if}
  <pre class="gen-ui-code__pre"><code>{props.code}</code></pre>
</div>

<style>
  .gen-ui-code {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .gen-ui-code__lang {
    font-size: 10px;
    color: var(--muted-foreground);
  }

  .gen-ui-code__pre {
    margin: 0;
    padding: 7px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--composer);
    color: var(--foreground);
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: 11px;
    line-height: 1.45;
    overflow: auto;
    white-space: pre;
  }

  /* The surface is the `pre`, and VS Code's webview hands an inline `code` a
     chip: background, border, radius and padding. An inline box paints once
     per line fragment, so an unstyled `code` turns every line of a snippet
     into its own rounded strip with a gap above and below it. Reset it here:
     the block fills the `pre`, and the colours come from the `pre` alone. */
  .gen-ui-code__pre code {
    display: block;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    white-space: inherit;
  }
</style>
