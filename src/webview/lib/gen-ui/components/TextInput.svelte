<script lang="ts">
  import { getBoundProp } from '@json-render/svelte'
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    label: string
    value?: string
    placeholder?: string
  }> {}

  let { props, bindings }: Props = $props()

  const value = $derived(getBoundProp<string>(() => props.value, () => bindings?.value))
</script>

<div class="field">
  <label>
    <span>{props.label}</span>
    <input
      type="text"
      placeholder={props.placeholder ?? ''}
      value={value.current ?? ''}
      oninput={(event) => { value.current = (event.currentTarget as HTMLInputElement).value }}
    />
  </label>
</div>

<style>
  /* The settings pages give their inputs a box with utilities, and Tailwind's
     preflight leaves a bare one transparent. The card draws the box from the
     sidebar's own tokens, so a field reads as a field. */
  input {
    width: 100%;
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--input);
    color: var(--foreground);
    font-size: 11px;
  }

  input::placeholder {
    color: var(--muted-foreground);
  }
</style>
