<script lang="ts">
  import { getBoundProp } from '@json-render/svelte'
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    label?: string
    options: string[]
    value?: string
  }> {}

  let { props, bindings }: Props = $props()

  const selected = $derived(getBoundProp<string>(() => props.value, () => bindings?.value))
</script>

<div class="grid gap-1.5">
  {#if props.label}
    <label>
      <span>{props.label}</span>
      <select
        value={selected.current ?? ''}
        onchange={(event) => { selected.current = (event.currentTarget as HTMLSelectElement).value }}
      >
        {#each props.options as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </label>
  {:else}
    <select
      value={selected.current ?? ''}
      onchange={(event) => { selected.current = (event.currentTarget as HTMLSelectElement).value }}
    >
      {#each props.options as option (option)}
        <option value={option}>{option}</option>
      {/each}
    </select>
  {/if}
</div>

<style>
  /* Same box as the text field: preflight strips a bare control to transparent,
     and the card has no utility classes to put it back. */
  select {
    width: 100%;
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--input);
    color: var(--foreground);
    font: inherit;
    font-size: 11px;
  }
</style>
