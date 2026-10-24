<script lang="ts">
  /**
   * The transcript marker for a plan mode switch: a rule that breaks for the
   * mode's name, the line reaching to both edges and fading out as it goes.
   */
  interface Props {
    /** The mode that took effect, shown in the middle of the rule. */
    label: string
  }

  let { label }: Props = $props()
</script>

<div class="mode-rule" role="separator" aria-label={label}>
  <span class="mode-rule-label">{label}</span>
</div>
