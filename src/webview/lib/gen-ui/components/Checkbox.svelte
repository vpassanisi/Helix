<script lang="ts">
  import { getBoundProp } from '@json-render/svelte'
  import type { BaseComponentProps } from '@json-render/svelte'

  interface Props extends BaseComponentProps<{
    label: string
    checked?: boolean
  }> {}

  let { props, bindings }: Props = $props()

  const checked = $derived(getBoundProp<boolean>(() => props.checked, () => bindings?.checked))
</script>

<div class="field" data-orientation="horizontal">
  <label>
    <input
      type="checkbox"
      checked={checked.current === true}
      onchange={(event) => { checked.current = (event.currentTarget as HTMLInputElement).checked }}
    />
    <span>{props.label}</span>
  </label>
</div>

<style>
  /* app.css styles `.field label` as an uppercase caption, which suits a
     text field's label and reads as shouting for a choice. The selector carries
     `.field` so it outranks that rule rather than racing it on source order. */
  .field label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--foreground);
    font-size: 11px;
    letter-spacing: 0;
    text-transform: none;
  }

  .field input[type='checkbox'] {
    flex: none;
    width: 13px;
    height: 13px;
    accent-color: var(--brand-gold);
  }
</style>
