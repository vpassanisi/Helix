<script lang="ts">
  import { ChevronDown, LoaderCircle, Wrench } from '@lucide/svelte'
  import { effectiveSkills, type SkillOverrides, type SkillSummary, type SkillSuggestions } from '../../shared/skills.js'
  let { skills, suggestions, overrides, disabled = false, error = '', onoverride }: {
    skills: SkillSummary[]; suggestions?: SkillSuggestions; overrides: SkillOverrides; disabled?: boolean; error?: string;
    onoverride: (value: SkillOverrides) => void
  } = $props()
  let open = $state(false)
  let search = $state('')
  const selected = $derived(effectiveSkills(suggestions?.selected ?? [], overrides))
  const rows = $derived(skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(selected.includes(b.name)) - Number(selected.includes(a.name)) || a.name.localeCompare(b.name)))
  const status = $derived(error || suggestions?.status === 'unavailable' ? 'Suggestions unavailable'
    : suggestions?.status === 'checking' ? 'Checking skills…' : suggestions?.status === 'disabled' ? 'Manual selection'
      : selected.length ? 'Ready' : 'No suggestions')
  function toggle(name: string, checked: boolean): void {
    onoverride({ include: [...overrides.include.filter((entry) => entry !== name), ...(checked ? [name] : [])],
      exclude: [...overrides.exclude.filter((entry) => entry !== name), ...(!checked ? [name] : [])] })
  }
</script>

<section class="accordion mb-2 min-w-0 rounded-[8px] border border-[var(--border)] bg-[var(--card)]" aria-label="Skills for the next message">
  <details bind:open>
    <summary class="flex flex-wrap items-center gap-[7px] px-[10px] py-[9px] cursor-pointer text-[11px] list-none [&::-webkit-details-marker]:hidden">
      <Wrench size={13} strokeWidth={1.7} />
      <span class="whitespace-nowrap">Skills <span class="text-[var(--muted-foreground)] tabular-nums">{selected.length}</span></span>
      <span class="inline-flex flex-1 items-center justify-end gap-[5px] text-[10px] text-[var(--muted-foreground)]" aria-live="polite">{#if suggestions?.status === 'checking'}<LoaderCircle class="animate-spin motion-reduce:animate-none" size={12} />{/if}{status}</span>
      <ChevronDown size={13} />
      {#if selected.length}<span class="flex basis-full flex-wrap gap-1">{#each selected as name (name)}<span class="badge max-w-full text-[9px] [overflow-wrap:anywhere]">{name}</span>{/each}</span>{/if}
    </summary>
    <section class="border-t border-[var(--border)] !p-2">
      <div class="flex items-center gap-1">
        <input class="input min-w-0 flex-1 h-[28px] text-[11px]" type="search" bind:value={search} placeholder="Find a skill…" aria-label="Search skills" />
        <button class="btn px-[6px] py-1 text-[10px] whitespace-nowrap" data-variant="ghost" type="button" disabled={disabled || (!overrides.include.length && !overrides.exclude.length)} onclick={() => onoverride({ include: [], exclude: [] })}>Reset choices</button>
      </div>
      {#if error || suggestions?.message}<p class="my-2 text-[10px] leading-[1.45] text-[var(--muted-foreground)] [overflow-wrap:anywhere]" role="status">{error || suggestions?.message}</p>{/if}
      {#if suggestions?.threshold !== undefined}
        <p class="my-2 text-[10px] leading-[1.45] text-[var(--muted-foreground)] [overflow-wrap:anywhere]">Auto-select at {(suggestions.threshold * 100).toFixed(1)}%{#if suggestions.elapsedMs !== undefined} · {suggestions.status === 'checking' ? 'Checking' : 'Checked'} in {suggestions.elapsedMs} ms{/if}</p>
      {/if}
      <div class="mt-[6px] max-h-[min(240px,30vh)] overflow-y-auto">
        {#each rows as skill (skill.name)}
          <label class="flex items-start gap-2 border-b border-[var(--border)] px-[2px] py-2 last:border-0 cursor-pointer">
            <input class="input mt-[2px] shrink-0" type="checkbox" checked={selected.includes(skill.name)} disabled={disabled || (!skill.userInvocable && !selected.includes(skill.name))}
              onchange={(event) => toggle(skill.name, event.currentTarget.checked)} />
            <span class="flex min-w-0 flex-1 flex-col gap-[3px]"><span class="text-[11px] [overflow-wrap:anywhere]">{skill.name}</span><span class="text-[10px] leading-[1.45] text-[var(--muted-foreground)] [overflow-wrap:anywhere]">{skill.description}</span>
              {#if suggestions?.probabilities[skill.name] !== undefined}
                <span class="text-[10px] text-[var(--muted-foreground)] tabular-nums">Match {(suggestions.probabilities[skill.name]! * 100).toFixed(1)}%</span>
              {:else if !skill.modelInvocable}<span class="text-[10px] text-[var(--muted-foreground)] tabular-nums">{skill.userInvocable ? 'Manual only' : 'Not invocable'}</span>{/if}
            </span>
            {#if overrides.exclude.includes(skill.name)}<span class="badge max-w-full text-[9px] [overflow-wrap:anywhere]" data-variant="outline">Excluded</span>
            {:else if overrides.include.includes(skill.name)}<span class="badge max-w-full text-[9px] [overflow-wrap:anywhere]" data-variant="outline">Manual</span>
            {:else if suggestions?.selected.includes(skill.name)}<span class="badge max-w-full text-[9px] [overflow-wrap:anywhere]" data-variant="secondary">Suggested</span>{/if}
          </label>
        {:else}<p class="my-2 text-[10px] leading-[1.45] text-[var(--muted-foreground)] [overflow-wrap:anywhere]">{skills.length ? 'No matching skills.' : 'No skills available.'}</p>{/each}
      </div>
    </section>
  </details>
</section>
