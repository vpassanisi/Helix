<script lang="ts">
  import { ChevronDown } from '@lucide/svelte'

  interface Props {
    label: string
    text: string
    active: boolean
  }

  let { label, text, active }: Props = $props()
  const activeEdgeClasses = "border-l-[color-mix(in_srgb,var(--brand-gold)_60%,var(--border))] before:absolute before:top-0 before:bottom-0 before:-left-px before:w-[2px] before:rounded-[2px] before:bg-[linear-gradient(180deg,transparent_15%,var(--brand-gold)_45%,#f5dfbd_50%,var(--brand-gold)_55%,transparent_85%)] before:[background-size:100%_250%] before:[box-shadow:0_0_6px_color-mix(in_srgb,var(--brand-gold)_25%,transparent)] before:pointer-events-none before:animate-thinking-edge before:content-[''] motion-reduce:before:animate-none motion-reduce:before:[background-position:0_50%]"
  /** The active label shimmers between a dark trough and a light peak: the trough sits
   * under the idle label's #b6b6b6 so the sweep reads as movement, not a static grey. */
  const activeLabelClasses = 'text-transparent [background-image:linear-gradient(110deg,#8a8a8a_30%,#dedede_48%,#8a8a8a_66%)] [background-size:250%_100%] bg-clip-text animate-thinking-shimmer motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-[#8a8a8a]'

  function isNearBottom(element: HTMLElement): boolean {
    return element.scrollHeight - element.clientHeight - element.scrollTop <= 24
  }

  function followStream(element: HTMLDivElement) {
    const details = element.parentElement as HTMLDetailsElement
    let following = true
    const scrollToLatest = () => {
      if (details.open && following) element.scrollTop = element.scrollHeight
    }
    const onScroll = () => { following = isNearBottom(element) }
    const observer = new MutationObserver(scrollToLatest)

    element.addEventListener('scroll', onScroll)
    details.addEventListener('toggle', scrollToLatest)
    observer.observe(element, { childList: true, characterData: true, subtree: true })

    return {
      destroy() {
        observer.disconnect()
        element.removeEventListener('scroll', onScroll)
        details.removeEventListener('toggle', scrollToLatest)
      },
    }
  }
</script>

<details class={`group/thinking relative border-l border-[var(--thinking-border)] pl-[10px] ${active ? activeEdgeClasses : ''}`} aria-busy={active}>
  <summary class="flex cursor-pointer list-none select-none items-center gap-[4px] text-[#b6b6b6] [&::-webkit-details-marker]:hidden">
    <span class={active ? activeLabelClasses : ''}>{label}</span>
    <ChevronDown class="flex-none opacity-0 [transition:opacity_.18s_ease,transform_.15s_ease] group-hover/thinking:opacity-100 group-focus-visible/thinking:opacity-100 group-open/thinking:rotate-180" size={13} strokeWidth={1.8} />
  </summary>
  <div class="whitespace-pre-wrap [overflow-wrap:anywhere] leading-[1.5] mt-[7px] max-h-[260px] overflow-auto" use:followStream>{text}</div>
</details>
