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
</style>
