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

<section class="accordion skills-drawer" aria-label="Skills for the next message">
  <details bind:open>
    <summary>
      <Wrench size={13} strokeWidth={1.7} />
      <span class="drawer-title">Skills <span class="skill-count">{selected.length}</span></span>
      <span class="skill-status" aria-live="polite">{#if suggestions?.status === 'checking'}<LoaderCircle class="spin" size={12} />{/if}{status}</span>
      <ChevronDown size={13} />
      {#if selected.length}<span class="skill-badges">{#each selected as name (name)}<span class="badge">{name}</span>{/each}</span>{/if}
    </summary>
    <section class="drawer-content">
      <div class="skill-actions">
        <input class="input" type="search" bind:value={search} placeholder="Find a skill…" aria-label="Search skills" />
        <button class="btn" data-variant="ghost" type="button" disabled={disabled || (!overrides.include.length && !overrides.exclude.length)} onclick={() => onoverride({ include: [], exclude: [] })}>Reset choices</button>
      </div>
      {#if error || suggestions?.message}<p class="skill-note" role="status">{error || suggestions?.message}</p>{/if}
      {#if suggestions?.threshold !== undefined}
        <p class="skill-note skill-routing-info">Auto-select at {(suggestions.threshold * 100).toFixed(1)}%{#if suggestions.elapsedMs !== undefined} · {suggestions.status === 'checking' ? 'Checking' : 'Checked'} in {suggestions.elapsedMs} ms{/if}</p>
      {/if}
      <div class="skill-list">
        {#each rows as skill (skill.name)}
          <label class="skill-row">
            <input class="input" type="checkbox" checked={selected.includes(skill.name)} disabled={disabled || (!skill.userInvocable && !selected.includes(skill.name))}
              onchange={(event) => toggle(skill.name, event.currentTarget.checked)} />
            <span class="skill-copy"><span class="skill-name">{skill.name}</span><span class="skill-description">{skill.description}</span>
              {#if suggestions?.probabilities[skill.name] !== undefined}
                <span class="skill-score">Match {(suggestions.probabilities[skill.name]! * 100).toFixed(1)}%</span>
              {:else if !skill.modelInvocable}<span class="skill-score">{skill.userInvocable ? 'Manual only' : 'Not invocable'}</span>{/if}
            </span>
            {#if overrides.exclude.includes(skill.name)}<span class="badge" data-variant="outline">Excluded</span>
            {:else if overrides.include.includes(skill.name)}<span class="badge" data-variant="outline">Manual</span>
            {:else if suggestions?.selected.includes(skill.name)}<span class="badge" data-variant="secondary">Suggested</span>{/if}
          </label>
        {:else}<p class="skill-note">{skills.length ? 'No matching skills.' : 'No skills available.'}</p>{/each}
      </div>
    </section>
  </details>
</section>

<style>
  .skills-drawer { border: 1px solid var(--border); border-radius: 8px; background: var(--card); margin-bottom: 8px; min-width: 0; }
  .skills-drawer summary { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; padding: 9px 10px; cursor: pointer; font-size: 11px; list-style: none; }
  .skills-drawer summary::-webkit-details-marker { display: none; }
  .drawer-title { white-space: nowrap; }
  .skill-count { color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
  .skill-status { display: inline-flex; align-items: center; justify-content: flex-end; gap: 5px; flex: 1; color: var(--muted-foreground); font-size: 10px; }
  .skill-badges { display: flex; flex-wrap: wrap; flex-basis: 100%; gap: 4px; }
  .badge { font-size: 9px; max-width: 100%; overflow-wrap: anywhere; }
  .drawer-content { border-top: 1px solid var(--border); padding: 8px !important; }
  .skill-actions { display: flex; align-items: center; gap: 4px; }
  .skill-actions .input { min-width: 0; flex: 1; font-size: 11px; height: 28px; }
  .skill-actions .btn { font-size: 10px; padding: 4px 6px; white-space: nowrap; }
  .skill-list { max-height: min(240px, 30vh); overflow-y: auto; margin-top: 6px; }
  .skill-row { display: flex; gap: 8px; align-items: flex-start; padding: 8px 2px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .skill-row:last-child { border-bottom: 0; }
  .skill-row input { margin-top: 2px; flex-shrink: 0; }
  .skill-copy { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  .skill-name { font-size: 11px; overflow-wrap: anywhere; }
  .skill-description, .skill-note { font-size: 10px; line-height: 1.45; color: var(--muted-foreground); overflow-wrap: anywhere; }
  .skill-score { font-size: 10px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
  .skill-note { margin: 8px 0; }
  :global(.skills-drawer .spin) { animation: rotate 1s linear infinite; }
  @keyframes rotate { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { :global(.skills-drawer .spin) { animation: none; } }
</style>
