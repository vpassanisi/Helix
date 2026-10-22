<script lang="ts">
  import { Check, LoaderCircle, RotateCcw } from '@lucide/svelte'
  import { TOOL_BUNDLE_OPTIONS, disabledToolNames, enabledToolNames, normalizeDisabledToolBundles, type ToolBundleGroup } from '../../shared/tool-bundles.js'

  interface Props {
    /** The bundles the page wants left out. */
    disabled: string[]
    /** The list saved in settings, used for the summary and the dirty check. */
    saved: string[]
    saving: boolean
    onSave: () => void
    onDiscard: () => void
  }

  let { disabled = $bindable(), saved, saving, onSave, onDiscard }: Props = $props()

  const groupLabels: Record<ToolBundleGroup, string> = {
    files: 'Files and search',
    shell: 'Shell and jobs',
    agents: 'Agents',
    planning: 'Planning',
    context: 'Context',
    web: 'Web',
  }
  const groups = (Object.keys(groupLabels) as ToolBundleGroup[])
    .map((id) => ({ id, options: TOOL_BUNDLE_OPTIONS.filter((option) => option.group === id) }))
    .filter((group) => group.options.length > 0)

  const openCount = $derived(enabledToolNames(disabled).length)
  const totalCount = $derived(TOOL_BUNDLE_OPTIONS.filter((option) => option.locked === undefined).reduce((total, option) => total + option.tools.length, 0))
  const savedOff = $derived(disabledToolNames(saved))
  const dirty = $derived(disabled.join('|') !== normalizeDisabledToolBundles(saved).join('|'))

  function isOn(id: string): boolean {
    return !disabled.includes(id)
  }

  function toggle(id: string, enabled: boolean): void {
    const off = new Set(disabled)
    if (enabled) off.delete(id)
    else off.add(id)
    disabled = normalizeDisabledToolBundles([...off])
  }
</script>

<form class="grid gap-[15px]" onsubmit={(event) => { event.preventDefault(); if (dirty && !saving) onSave() }}>
  <p class="m-0 max-w-[46ch] text-[var(--muted-foreground)] text-[11px] leading-[1.55]">
    Tools are the capabilities the assistant can call during a turn. Switch one off to leave it out of the runtime, which keeps it out of every request and off the model&rsquo;s token bill.
  </p>

  <div class="flex flex-wrap items-baseline gap-x-[10px] gap-y-[4px] text-[10px] leading-[1.4] text-[var(--muted-foreground)]" role="status">
    <span class="text-[var(--foreground)] font-[650]">{openCount} of {totalCount} tools on</span>
    {#if savedOff.length}
      <span>Off in the running runtime: {savedOff.join(', ')}.</span>
    {/if}
  </div>

  <p class="m-0 max-w-[46ch] rounded-[var(--radius)] border border-[#645432] bg-[#201d17] px-[9px] py-2 text-[10px] leading-[1.45] text-[#e2cf9f]">
    Saving does not restart anything. The current session keeps the tools it started with. The saved list applies the next time the runtime starts, which happens when you start a new session.
  </p>

  {#each groups as group (group.id)}
    <div class="card min-w-0 shadow-none" data-size="sm">
      <header>
        <h3 class="text-[var(--muted-foreground)] text-[10px] tracking-[.08em] uppercase">{groupLabels[group.id]}</h3>
      </header>
      <section class="grid gap-[9px]">
        {#each group.options as option (option.id)}
          {@const locked = option.locked !== undefined}
          {@const rowId = `tool-bundle-${option.id}`}
          <div class="flex min-w-0 items-start gap-[9px]">
            <input
              id={rowId}
              class="input h-[14px] w-[24px] min-w-0 flex-none p-0 mt-[2px]"
              type="checkbox"
              role="switch"
              data-size="sm"
              checked={isOn(option.id)}
              disabled={locked}
              title={locked ? 'Helix keeps this bundle off for its runtime.' : undefined}
              aria-describedby={`${rowId}-hint`}
              onchange={(event) => toggle(option.id, (event.currentTarget as HTMLInputElement).checked)} />
            <div class="grid min-w-0 gap-[3px]">
              <div class="flex flex-wrap items-baseline gap-[7px]">
                <label class="text-[11px] font-[600]" for={rowId}>{option.label}</label>
                {#each option.tools as tool (tool)}
                  <code class="badge px-[5px] py-[1px] text-[9px] leading-[1.4] text-[var(--muted-foreground)]">{tool}</code>
                {/each}
              </div>
              <small id={`${rowId}-hint`} class="text-[var(--muted-foreground)] text-[10px] leading-[1.4]">{option.hint}</small>
            </div>
          </div>
        {/each}
      </section>
    </div>
  {/each}

  <div class="flex min-w-0 flex-wrap items-center gap-[7px]">
    <button class="btn inline-flex items-center gap-[6px] border-0 bg-[var(--primary)] font-[650]! text-[var(--primary-foreground)]!" type="submit" disabled={!dirty || saving}>
      {#if saving}<LoaderCircle class="animate-spin motion-reduce:animate-none" size={13} strokeWidth={1.8} /> Saving…{:else}Save tools <Check size={13} strokeWidth={1.8} />{/if}
    </button>
    <button class="btn inline-flex items-center gap-[6px]" data-variant="ghost" type="button" onclick={onDiscard} disabled={!dirty || saving}>
      <RotateCcw size={13} strokeWidth={1.8} /> Discard changes
    </button>
    {#if dirty}
      <span class="text-[var(--muted-foreground)] text-[10px] leading-[1.4]">Unsaved changes.</span>
    {/if}
  </div>
</form>
