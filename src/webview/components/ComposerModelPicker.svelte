<script lang="ts">
  import { onMount } from 'svelte'
  import { Brain, Check } from '@lucide/svelte'
  import { isBinaryReasoningFormat, selectableReasoningEfforts } from '../../runtime/model-catalog.js'
  import type { SidebarModel } from '../types.js'

  interface Props {
    models: SidebarModel[]
    model: string
    reasoningEffort: string | null
    modelChanging: boolean
    modelOptionLabel: (option: SidebarModel) => string
    onModelSelect: (model: string) => void
    onReasoningEffortSelect: (effort: string) => void
  }

  let { models, model, reasoningEffort, modelChanging, modelOptionLabel, onModelSelect, onReasoningEffortSelect }: Props = $props()

  const selectedModel = $derived(models.find((option) => option.id === model))
  const efforts = $derived(selectableReasoningEfforts(selectedModel))
  const modelLabel = $derived(selectedModel ? modelOptionLabel(selectedModel)
    : model || (models.length === 0 ? 'No saved models' : 'Select model'))
  const effortLabel = $derived(selectedModel && isBinaryReasoningFormat(selectedModel.reasoningFormat)
    ? selectedModel.binaryThinkingMode === 'off' ? 'Thinking Off' : 'Thinking On'
    : reasoningEffort ?? 'Provider controlled')
  const triggerLabel = $derived(`Model: ${modelLabel}; Reasoning effort: ${effortLabel}`)

  onMount(() => {
    const basecoat = (window as Window & { basecoat?: { init?: (component: string) => void } }).basecoat
    basecoat?.init?.('popover')
  })
</script>

<div class="flex min-w-0 flex-none items-center">
  <div id="composer-model-selector" class="popover flex-none">
    <button
      id="composer-model-trigger"
      class="btn composer-tooltip h-[27px] w-[28px] border-0 bg-transparent p-0 text-[var(--muted-foreground)] hover:enabled:bg-[var(--color-muted,var(--muted))] hover:enabled:text-[var(--foreground)]"
      data-variant="ghost"
      data-size="icon-sm"
      type="button"
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-controls="composer-model-popover"
      aria-label={triggerLabel}
      data-tooltip={triggerLabel}
      data-side="top"
      data-align="end"
    >
      <Brain size={16} strokeWidth={1.8} aria-hidden="true" />
    </button>
    <div
      id="composer-model-popover"
      class="right-[-52px] max-h-[min(460px,calc(100vh-80px))] w-[min(320px,calc(100vw-28px))] overflow-y-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--popover)] p-[10px] text-[var(--popover-foreground)]"
      data-popover
      data-side="top"
      data-align="end"
      aria-hidden="true"
      role="dialog"
      aria-label="Model and reasoning"
    >
      <section class="grid gap-[4px]" aria-labelledby="composer-effort-options-title">
        <h4 id="composer-effort-options-title" class="px-[7px] text-[9px] font-semibold tracking-[.08em] text-[var(--muted-foreground)] uppercase">Reasoning effort</h4>
        {#if !model}
          <p class="px-[7px] py-[5px] text-[10px] leading-[1.4] text-[var(--muted-foreground)]">Choose a model to see its defined levels.</p>
        {:else if efforts.length === 0}
          <p class="px-[7px] py-[5px] text-[10px] leading-[1.4] text-[var(--muted-foreground)]">This model has no selectable reasoning levels.</p>
        {:else}
          <div class="grid max-h-[170px] gap-px overflow-y-auto" role="group" aria-labelledby="composer-effort-options-title">
            {#each efforts as effort (`${model}-${effort}`)}
              <button
                class="btn flex min-h-[27px] min-w-0 items-center justify-between gap-[8px] rounded-[4px] border-0 px-[7px] py-[5px] text-left text-[10px]! text-[var(--muted-foreground)] hover:enabled:bg-[var(--accent)] hover:enabled:text-[var(--foreground)] aria-pressed:bg-[var(--accent)] aria-pressed:text-[var(--foreground)]"
                data-variant="ghost"
                type="button"
                aria-pressed={reasoningEffort === effort}
                onclick={() => onReasoningEffortSelect(effort)}
              >
                <span class="min-w-0 wrap-anywhere">{effort}</span>
                {#if reasoningEffort === effort}<Check class="flex-none" size={12} strokeWidth={2} aria-hidden="true" />{/if}
              </button>
            {/each}
          </div>
        {/if}
      </section>
      <section class="mt-[5px] grid gap-[4px] border-t border-[var(--border)] pt-[6px]" aria-labelledby="composer-model-options-title">
        <h4 id="composer-model-options-title" class="px-[7px] text-[9px] font-semibold tracking-[.08em] text-[var(--muted-foreground)] uppercase">Model</h4>
        <div class="grid max-h-[170px] gap-px overflow-y-auto" role="group" aria-labelledby="composer-model-options-title">
          {#if models.length === 0}
            <p class="px-[7px] py-[5px] text-[10px] leading-[1.4] text-[var(--muted-foreground)]" role="status">No saved models. Add one in Settings.</p>
          {:else}
            {#each models as option (option.id)}
              <button
                class="btn flex min-h-[27px] min-w-0 items-center justify-between gap-[8px] rounded-[4px] border-0 px-[7px] py-[5px] text-left text-[10px]! text-[var(--muted-foreground)] hover:enabled:bg-[var(--accent)] hover:enabled:text-[var(--foreground)] aria-pressed:bg-[var(--accent)] aria-pressed:text-[var(--foreground)]"
                data-variant="ghost"
                type="button"
                aria-pressed={model === option.id}
                disabled={modelChanging}
                onclick={() => onModelSelect(option.id)}
              >
                <span class="min-w-0 wrap-anywhere">{modelOptionLabel(option)}</span>
                {#if model === option.id}<Check class="flex-none" size={12} strokeWidth={2} aria-hidden="true" />{/if}
              </button>
            {/each}
          {/if}
        </div>
      </section>
    </div>
  </div>
</div>
