<script lang="ts">
  // A spec asked for a component Helix does not ship. Naming it is the point:
  // the transcript shows what the model reached for, and the card stays intact.
  let { element }: { element: { type?: string } } = $props()
</script>

<span class="inline-flex items-center gap-[4px] rounded-[var(--radius)] border border-dashed border-[var(--border)] px-[6px] py-[2px] text-[10px] text-[var(--muted-foreground)]">
  {element?.type ? `${element.type} is not a Helix component` : 'Unusable element'}
</span>
