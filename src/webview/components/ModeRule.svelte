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

<div
  class="flex items-center gap-[9px] px-2.5 text-[9px] font-semibold tracking-[.14em] whitespace-nowrap uppercase text-[color-mix(in_srgb,var(--brand-gold)_82%,var(--muted-foreground))] before:content-[''] before:flex-1 before:min-w-3 before:h-px before:bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--brand-gold)_42%,var(--border)))] after:content-[''] after:flex-1 after:min-w-3 after:h-px after:bg-[linear-gradient(90deg,color-mix(in_srgb,var(--brand-gold)_42%,var(--border)),transparent)]"
  role="separator"
  aria-label={label}
>
  <span>{label}</span>
</div>
