<script lang="ts">
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    caption?: string
    columns: string[]
    rows: string[][]
  }> {}

  let { props }: Props = $props()
</script>

<div class="table-container">
  <table class="table gen-ui-table">
    <thead>
      <tr>
        {#each props.columns as column (column)}
          <th scope="col">{column}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each props.rows as row, index (index)}
        <tr>
          {#each row as cell, column (column)}
            <td>{cell}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
    {#if props.caption}<caption>{props.caption}</caption>{/if}
  </table>
</div>

<style>
  .gen-ui-table {
    font-size: 11px;
    table-layout: fixed;
  }

  .gen-ui-table th,
  .gen-ui-table td {
    /* Basecoat keeps cells on one line; a sidebar needs the text to wrap. */
    white-space: normal;
    overflow-wrap: anywhere;
    vertical-align: top;
    padding: 4px 6px;
    text-align: start;
  }

  .gen-ui-table th {
    height: auto;
    color: var(--muted-foreground);
    font-weight: 600;
  }

  .gen-ui-table tr {
    border-color: var(--border);
  }

  .gen-ui-table caption {
    margin-top: 6px;
    font-size: 10px;
    text-align: start;
  }
</style>
