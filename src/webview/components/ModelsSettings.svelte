<script lang="ts">
  import { tick } from 'svelte'
  import { Check, ChevronDown, LoaderCircle, RefreshCw, Server, Trash2 } from '@lucide/svelte'
  import { DSH_REASONING_FORMATS, DSH_REASONING_LEVELS, isBinaryReasoningFormat, updateReasoningEffortSelection, type ReasoningFormat } from '../../runtime/model-catalog.js'
  import type { ModelEditorDraft, SidebarDiscoveredModel, SidebarModel } from '../types.js'

  interface Props {
    modelDrafts: ModelEditorDraft[]
    discoveredModels: SidebarDiscoveredModel[]
    modelsLoading: boolean
    modelsError: string
    modelCatalogLoading: boolean
    modelCatalogSaving: boolean
    modelCatalogError: string
    modelOptionLabel: (option: SidebarModel) => string
    onAddModel: (id: string) => void
    onRefreshModels: () => void
    onSaveModels: () => void
    onStatus: (text: string, tone: 'success' | 'warning' | '') => void
  }

  let { modelDrafts = $bindable(), discoveredModels, modelsLoading, modelsError, modelCatalogLoading,
    modelCatalogSaving, modelCatalogError, modelOptionLabel, onAddModel, onRefreshModels, onSaveModels, onStatus }: Props = $props()
  let root = $state<HTMLDivElement>()
  let modelSourcePickerElement = $state<HTMLDivElement & { clear?: () => void; refresh?: () => void }>()
  const reasoningFormatOptions: ReasoningFormat[] = ['auto', ...DSH_REASONING_FORMATS]
  const editsDisabled = $derived(modelCatalogSaving || modelCatalogLoading || modelCatalogError !== '')
  const sourceDisabled = $derived(modelsLoading || modelCatalogLoading || modelCatalogError !== '')
  const pickerRevision = $derived(JSON.stringify([
    modelCatalogLoading, modelCatalogError, modelsLoading, modelsError, discoveredModels,
    modelDrafts.map((draft) => [draft.key, draft.id, draft.reasoningFormat, draft.binaryThinkingMode]),
  ]))

  const cardInputClass = 'input min-w-0 h-[28px] px-[7px] py-0 text-[10px]!'
  const selectTriggerClass = 'btn flex h-[28px] w-full items-center justify-between px-[7px] py-0 text-[10px]! [&>span]:truncate'
  const selectPopoverClass = 'w-max min-w-full max-w-[min(300px,calc(100vw-28px))] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--popover)] p-[5px] text-[var(--popover-foreground)]'
  const selectOptionClass = 'flex min-w-0 cursor-pointer items-center rounded-[4px] px-[8px] py-[7px] text-[10px] leading-[1.3] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] [&.active]:bg-[var(--accent)] [&.active]:text-[var(--foreground)] aria-selected:bg-[var(--accent)] aria-selected:text-[var(--foreground)]'
  const reasoningLabelClass = 'block h-[1.2em] text-[9px]! leading-[1.2] tracking-normal! whitespace-nowrap normal-case!'
  const templateInputClass = 'textarea min-h-[64px] resize-y px-[7px] py-[6px] text-[10px]! leading-[1.4]! [font-family:var(--vscode-editor-font-family,monospace)]!'

  // Refresh Basecoat after options arrive or a draft adds/replaces card controls.
  $effect(() => {
    const revision = pickerRevision
    let current = true
    void tick().then(() => {
      if (!current || revision !== pickerRevision || !root) return
      const basecoat = (window as Window & { basecoat?: { init?: (component: string) => void } }).basecoat
      basecoat?.init?.('combobox')
      basecoat?.init?.('select')
      basecoat?.init?.('popover')
      root.querySelectorAll<HTMLDivElement & { refresh?: () => void }>('[data-model-select]').forEach((picker) => picker.refresh?.())
      modelSourcePickerElement?.refresh?.()
    })
    return () => { current = false }
  })

  function handleAddDiscoveredModel(event: Event): void {
    const selectedId = (event as CustomEvent<{ value?: string }>).detail?.value
    if (typeof selectedId !== 'string' || !selectedId) return
    onAddModel(selectedId)
    modelSourcePickerElement?.clear?.()
  }

  function removeModelDraft(key: number): void {
    modelDrafts = modelDrafts.filter((draft) => draft.key !== key)
  }

  function modelReasoningEffortChoices(draft: ModelEditorDraft): string[] {
    const legacy = draft.reasoningEfforts.filter((effort) => !(DSH_REASONING_LEVELS as readonly string[]).includes(effort))
    return [...DSH_REASONING_LEVELS, ...legacy]
  }

  function isLegacyModelEffort(effort: string): boolean {
    return !(DSH_REASONING_LEVELS as readonly string[]).includes(effort)
  }

  function modelEffortSummary(draft: ModelEditorDraft): string {
    const count = draft.reasoningEfforts.length
    return count === 0 ? 'Provider controlled' : `${count} selected`
  }

  function handleModelReasoningEffortChange(key: number, effort: string, event: Event): void {
    const draft = modelDrafts.find((entry) => entry.key === key)
    const input = event.currentTarget
    if (draft === undefined || !(input instanceof HTMLInputElement)) return
    const updated = updateReasoningEffortSelection(
      draft.reasoningEfforts,
      effort,
      input.checked,
    )
    if (updated === undefined) {
      input.checked = false
      onStatus('Select at least one graded level before enabling Off.', 'warning')
      return
    }
    draft.reasoningEfforts = updated
  }

  function handleModelReasoningFormatChange(key: number, event: Event): void {
    const draft = modelDrafts.find((entry) => entry.key === key)
    const selected = (event as CustomEvent<{ value?: string }>).detail?.value
    const value = typeof selected === 'string' && selected.startsWith('format-') ? selected.slice('format-'.length) : selected
    if (draft === undefined || !isReasoningFormatOption(value)) return
    draft.reasoningFormat = value
    if (isBinaryReasoningFormat(value)) draft.binaryThinkingMode ??= 'on'
  }

  function handleBinaryThinkingModeChange(key: number, event: Event): void {
    const draft = modelDrafts.find((entry) => entry.key === key)
    const value = (event as CustomEvent<{ value?: string }>).detail?.value
    if (draft === undefined || (value !== 'on' && value !== 'off')) return
    draft.binaryThinkingMode = value
  }

  function isReasoningFormatOption(value: unknown): value is ReasoningFormat {
    return typeof value === 'string' && reasoningFormatOptions.includes(value as ReasoningFormat)
  }
</script>

<div class="grid gap-[15px]" bind:this={root}>
  <section class="m-0 min-w-0 p-0" aria-labelledby="model-settings-title">
    <div class="mb-[10px]">
      <h3 id="model-settings-title" class="m-0 text-[11px] font-[650] tracking-[.04em] text-[var(--foreground)]">Models</h3>
    </div>

    {#if modelsError}<p class="my-[7px]! text-[10px] leading-[1.4] text-[#d0d0d0]" role="status">{modelsError}</p>{/if}
    {#if modelCatalogError}<p class="my-[7px]! text-[10px] leading-[1.4] text-[#d0d0d0]" role="alert">{modelCatalogError} Model edits are disabled to protect the saved file.</p>{/if}

    <div class="mb-[10px] flex min-w-0 items-center gap-[8px]">
      <div
        id="model-source-picker"
        class="combobox flex min-w-0 flex-1"
        bind:this={modelSourcePickerElement}
        onchange={handleAddDiscoveredModel}
      >
        <input
          type="text"
          class="input h-[30px] w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--input)] py-0 pr-[30px] pl-[8px] text-[10px]! text-[var(--foreground)]"
          role="combobox"
          placeholder={modelsLoading ? 'Loading endpoint models…' : 'Search fetched models to add'}
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          aria-autocomplete="list"
          aria-expanded="false"
          aria-controls="model-source-listbox"
          aria-label="Add a fetched model"
          disabled={sourceDisabled}
        />
        <ChevronDown class="combobox-trigger-icon right-[8px] h-[14px] w-[14px] text-[var(--muted-foreground)]" size={14} strokeWidth={1.7} aria-hidden="true" />
        <div id="model-source-popover" class="z-20 max-h-[250px] w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--popover)] p-[4px] text-[var(--popover-foreground)]" data-popover aria-hidden="true">
          <div
            id="model-source-listbox"
            class="max-h-[240px] [&::before]:min-h-[30px] [&::before]:px-[8px] [&::before]:py-[6px] [&::before]:text-[10px] [&::before]:text-[var(--muted-foreground)]"
            role="listbox"
            aria-orientation="vertical"
            data-empty={modelsLoading ? 'Loading endpoint models…' : modelsError || 'No endpoint models found.'}
          >
            {#each discoveredModels as option (option.id)}
              <div
                role="option"
                class="min-h-[27px] rounded-[4px] px-[8px] py-[6px] text-[10px] leading-[1.4] text-[var(--muted-foreground)]"
                data-value={option.id}
                data-filter={`${option.displayName ?? ''} ${option.id}`}
                aria-selected="false"
                aria-disabled={modelDrafts.some((draft) => draft.id === option.id) ? 'true' : undefined}
              >
                {modelOptionLabel(option)}
              </div>
            {/each}
          </div>
        </div>
        <input type="hidden" name="discovered-model" value="" />
      </div>
      <button class="btn inline-flex h-[30px] flex-none items-center gap-[5px] px-[8px] py-0 text-[10px]! whitespace-nowrap" data-variant="outline" type="button" onclick={onRefreshModels} disabled={sourceDisabled}>
        {#if modelsLoading}<LoaderCircle class="animate-spin motion-reduce:animate-none" size={13} strokeWidth={1.8} />{:else}<RefreshCw size={13} strokeWidth={1.8} />{/if}
        Refresh list
      </button>
    </div>

    {#if modelCatalogLoading}
      <div class="flex items-center gap-[7px] pt-[11px] pb-[2px] text-[10px] text-[var(--muted-foreground)]"><LoaderCircle class="animate-spin motion-reduce:animate-none" size={14} strokeWidth={1.8} /> Loading saved models…</div>
    {:else if modelDrafts.length === 0}
      <div class="flex items-center gap-[7px] pt-[11px] pb-[2px] text-[10px] text-[var(--muted-foreground)]"><Server size={14} strokeWidth={1.7} /> No saved models yet. Add one from the fetched list above.</div>
    {:else}
      <div class="grid gap-[9px]">
        {#each modelDrafts as draft (draft.key)}
          <fieldset class="m-0 min-w-0 rounded-[var(--radius)] border border-[#343b42] bg-[var(--composer)] px-[10px] pt-[9px] pb-[10px]">
            <legend class="flex w-full items-center justify-between px-[4px] py-0 text-[10px] font-semibold text-[var(--foreground)]">
              <span>{draft.displayName || draft.id || 'New model'}</span>
              <button class="btn h-[24px] w-[24px] p-0 text-[var(--muted-foreground)]!" data-variant="ghost" data-size="icon" type="button" aria-label={`Remove ${draft.displayName || draft.id || 'model'}`} title="Remove model" onclick={() => removeModelDraft(draft.key)} disabled={editsDisabled}>
                <Trash2 size={13} strokeWidth={1.8} />
              </button>
            </legend>
            <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,.85fr)] gap-[9px] [@media(max-width:360px)]:grid-cols-1">
              <div class="field col-span-full min-w-0 [@media(max-width:360px)]:col-auto" role="group">
                <label class="text-[9px]!" for={`model-id-${draft.key}`}>Model ID</label>
                <input id={`model-id-${draft.key}`} class={cardInputClass} bind:value={draft.id} autocomplete="off" disabled={editsDisabled} />
              </div>
              <div class="field min-w-0" role="group">
                <label class="text-[9px]!" for={`model-label-${draft.key}`}>Display name</label>
                <input id={`model-label-${draft.key}`} class={cardInputClass} bind:value={draft.displayName} placeholder="Optional" autocomplete="off" disabled={editsDisabled} />
              </div>
              <div class="field min-w-0" role="group">
                <label class="text-[9px]!" for={`model-context-${draft.key}`}>Context window</label>
                <input id={`model-context-${draft.key}`} class={cardInputClass} type="number" min="1" step="1" bind:value={draft.contextWindow} placeholder="Unknown" disabled={editsDisabled} />
              </div>
              <div class="field col-span-full min-w-0">
                <div class="flex items-center justify-start gap-[8px]">
                  <label class="text-[9px]!" for={`model-vision-${draft.key}`}>Vision</label>
                  <input id={`model-vision-${draft.key}`} class="input h-[14px] w-[24px] min-w-0 flex-none p-0 text-[10px]!" type="checkbox" role="switch" data-size="sm" bind:checked={draft.acceptsImages} aria-describedby={`model-vision-help-${draft.key}`} disabled={editsDisabled} />
                </div>
                <small class="text-[9px]! leading-[1.35]!" id={`model-vision-help-${draft.key}`}>Allow image input if the endpoint supports it.</small>
              </div>
              <div class="field min-w-0 content-start" role="group">
                <label class={reasoningLabelClass} for={`model-reasoning-format-trigger-${draft.key}`}>Reasoning format</label>
                <div
                  id={`model-reasoning-format-${draft.key}`}
                  class="select block min-w-0"
                  data-model-select
                  data-placeholder="Auto / DSH default"
                  onchange={(event) => handleModelReasoningFormatChange(draft.key, event)}
                >
                  <button
                    id={`model-reasoning-format-trigger-${draft.key}`}
                    class={selectTriggerClass}
                    data-variant="outline"
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded="false"
                    aria-controls={`model-reasoning-format-listbox-${draft.key}`}
                    disabled={editsDisabled}
                  >
                    <span>{draft.reasoningFormat === 'auto' || draft.reasoningFormat === undefined ? 'Auto / DSH default' : draft.reasoningFormat}</span>
                    <ChevronDown size={13} strokeWidth={1.7} />
                  </button>
                  <div class={selectPopoverClass} data-popover aria-hidden="true" data-side="bottom" data-align="start">
                    <div id={`model-reasoning-format-listbox-${draft.key}`} class="max-h-[230px] overflow-auto" role="listbox" aria-orientation="vertical" aria-labelledby={`model-reasoning-format-trigger-${draft.key}`}>
                      {#each reasoningFormatOptions as format (`${draft.key}-${format}`)}
                        <div class={selectOptionClass} role="option" data-value={`format-${format}`} aria-selected={(draft.reasoningFormat ?? 'auto') === format ? 'true' : undefined}>{format === 'auto' ? 'Auto / DSH default' : format}</div>
                      {/each}
                    </div>
                  </div>
                  <input type="hidden" name={`model-reasoning-format-${draft.key}`} value={`format-${draft.reasoningFormat ?? 'auto'}`} />
                </div>
              </div>
              {#if isBinaryReasoningFormat(draft.reasoningFormat)}
                <div class="field min-w-0" role="group">
                  <label class="text-[9px]!" for={`model-binary-thinking-trigger-${draft.key}`}>Thinking mode</label>
                  <div
                    id={`model-binary-thinking-${draft.key}`}
                    class="select block min-w-0"
                    data-model-select
                    data-placeholder="On"
                    onchange={(event) => handleBinaryThinkingModeChange(draft.key, event)}
                  >
                    <button id={`model-binary-thinking-trigger-${draft.key}`} class={selectTriggerClass} data-variant="outline" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls={`model-binary-thinking-listbox-${draft.key}`} disabled={editsDisabled}>
                      <span>{draft.binaryThinkingMode === 'off' ? 'Off' : 'On'}</span>
                      <ChevronDown size={13} strokeWidth={1.7} />
                    </button>
                    <div class={selectPopoverClass} data-popover aria-hidden="true" data-side="bottom" data-align="start">
                      <div id={`model-binary-thinking-listbox-${draft.key}`} class="max-h-[230px] overflow-auto" role="listbox" aria-orientation="vertical" aria-labelledby={`model-binary-thinking-trigger-${draft.key}`}>
                        <div class={selectOptionClass} role="option" data-value="on" aria-selected={draft.binaryThinkingMode === 'on' ? 'true' : undefined}>On</div>
                        <div class={selectOptionClass} role="option" data-value="off" aria-selected={draft.binaryThinkingMode === 'off' ? 'true' : undefined}>Off</div>
                      </div>
                    </div>
                    <input type="hidden" name={`model-binary-thinking-${draft.key}`} value={draft.binaryThinkingMode ?? 'on'} />
                  </div>
                  <small>This format has a binary control, so the composer has no effort selector.</small>
                </div>
              {:else}
                <div class="field min-w-0 content-start" role="group">
                  <label class={reasoningLabelClass} id={`model-reasoning-level-label-${draft.key}`} for={`model-reasoning-level-trigger-${draft.key}`}>Reasoning levels</label>
                  <div
                    id={`model-reasoning-level-picker-${draft.key}`}
                    class="popover block min-w-0"
                  >
                    <button id={`model-reasoning-level-trigger-${draft.key}`} class={selectTriggerClass} data-variant="outline" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls={`model-reasoning-level-popover-${draft.key}`} disabled={editsDisabled}>
                      <span>{modelEffortSummary(draft)}</span>
                      <ChevronDown size={13} strokeWidth={1.7} />
                    </button>
                    <div id={`model-reasoning-level-popover-${draft.key}`} class="w-max min-w-[min(100%,210px)] max-w-[min(280px,calc(100vw-28px))] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--popover)] p-[8px] text-[var(--popover-foreground)]" data-popover aria-hidden="true" data-side="bottom" data-align="start" role="dialog" aria-labelledby={`model-reasoning-level-label-${draft.key}`}>
                      <fieldset class="m-0 grid max-h-[240px] min-w-0 gap-[2px] overflow-auto border-0 p-0">
                        <legend class="mb-[4px] text-[9px] font-semibold text-[var(--muted-foreground)]">Choose supported levels</legend>
                        {#each modelReasoningEffortChoices(draft) as effort, index (`${draft.key}-${effort}`)}
                          <div class="field flex! min-w-0 cursor-pointer items-center gap-[8px] rounded-[4px] px-[6px] py-[5px] hover:bg-[var(--accent)]" data-orientation="horizontal">
                            <input id={`model-reasoning-level-${draft.key}-${index}`} class="input m-0 h-[14px] w-[14px] min-w-0 flex-none px-[7px] py-0 text-[10px]!" type="checkbox" checked={draft.reasoningEfforts.includes(effort)} onchange={(event) => handleModelReasoningEffortChange(draft.key, effort, event)} disabled={editsDisabled} />
                            <label class="cursor-pointer text-[10px]! tracking-normal! text-[var(--foreground)]! normal-case!" for={`model-reasoning-level-${draft.key}-${index}`}>{effort}{#if isLegacyModelEffort(effort)} <span class="text-[9px] text-[var(--muted-foreground)]">(saved ID)</span>{/if}</label>
                          </div>
                        {/each}
                      </fieldset>
                    </div>
                  </div>
                </div>
              {/if}
              {#if draft.reasoningFormat === 'chat-template'}
                <div class="field col-span-full min-w-0" role="group">
                  <label class="text-[9px]!" for={`model-chat-template-kwargs-${draft.key}`}>chatTemplateKwargs (JSON)</label>
                  <textarea id={`model-chat-template-kwargs-${draft.key}`} class={templateInputClass} rows="4" bind:value={draft.chatTemplateKwargsText} placeholder={'{\n  "enable_thinking": { "$var": "thinking.enabled", "omitWhenOff": true }\n}'} disabled={editsDisabled}></textarea>
                  <small class="text-[9px]!">Values may be strings, numbers, booleans, null, or DSH variables: thinking.enabled, thinking.effort, thinking.budget.</small>
                </div>
              {/if}
              {#if draft.reasoningFormat === 'baseten'}
                <div class="field col-span-full min-w-0" role="group">
                  <label class="text-[9px]!" for={`model-chat-template-args-${draft.key}`}>chatTemplateArgs (JSON)</label>
                  <textarea id={`model-chat-template-args-${draft.key}`} class={templateInputClass} rows="4" bind:value={draft.chatTemplateArgsText} placeholder={'{\n  "reasoning_effort": { "$var": "thinking.effort" }\n}'} disabled={editsDisabled}></textarea>
                  <small class="text-[9px]!">Values may be strings, numbers, booleans, null, or DSH variables: thinking.enabled, thinking.effort, thinking.budget.</small>
                </div>
              {/if}
            </div>
          </fieldset>
        {/each}
      </div>
    {/if}

    <div class="mt-[10px] flex items-center justify-between gap-[8px] [@media(max-width:360px)]:flex-col [@media(max-width:360px)]:items-start">
      <button class="btn inline-flex items-center gap-[6px] border-0 bg-[var(--primary)] font-[650]! text-[var(--primary-foreground)]!" type="button" onclick={onSaveModels} disabled={editsDisabled}>
        {#if modelCatalogSaving}<LoaderCircle class="animate-spin motion-reduce:animate-none" size={13} strokeWidth={1.8} /> Saving…{:else}Save models <Check size={13} strokeWidth={1.8} />{/if}
      </button>
    </div>
  </section>
</div>
