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

<div class="grid gap-1.5" data-orientation="horizontal">
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
  /* A checkbox label is a choice, not a caption: keep it sentence-cased and
     on one line with the control. */
  label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--foreground);
    font-size: 11px;
    letter-spacing: 0;
    text-transform: none;
  }

  input[type='checkbox'] {
    flex: none;
    width: 13px;
    height: 13px;
    accent-color: var(--brand-gold);
  }
</style>
