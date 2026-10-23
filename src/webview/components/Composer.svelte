<script lang="ts">
  import { ArrowUp, Code2, MousePointer2, Square, X } from '@lucide/svelte'
  import BrowserAttachments from './BrowserAttachments.svelte'
  import ChangesPanel from './ChangesPanel.svelte'
  import ComposerModelPicker from './ComposerModelPicker.svelte'
  import ComposerPrompt from './ComposerPrompt.svelte'
  import SkillsDrawer from './SkillsDrawer.svelte'
  import { formatTokenCount, selectionLineLabel } from '../formatting.js'
  import type { ComposerCommandState } from '../lib/composer-commands.svelte.js'
  import type { BrowserContextState } from '../../shared/browser-context.js'
  import type { SkillOverrides, SkillSuggestions, SkillSummary } from '../../shared/skills.js'
  import type { CodeChange, SelectionMetadata, SidebarModel } from '../types.js'

  interface Props {
    prompt: string
    isGenerating: boolean
    waitingForAnswer: boolean
    submissionPending: boolean
    selection?: SelectionMetadata
    selectionAttached: boolean
    browserContext?: BrowserContextState
    codeChanges: CodeChange[]
    changesOpen: boolean
    models: SidebarModel[]
    model: string
    reasoningEffort: string | null
    modelChanging: boolean
    contextUsedTokens?: number
    contextWindowTokens?: number
    skillPickerEnabled: boolean
    skills: SkillSummary[]
    skillSuggestions?: SkillSuggestions
    skillOverrides: SkillOverrides
    skillError: string
    commands: ComposerCommandState
    modelOptionLabel: (option: SidebarModel) => string
    onSubmit: () => void
    onModelSelect: (model: string) => void
    onReasoningEffortSelect: (effort: string) => void
    onRemoveBrowserAttachment: (id: string) => void
    onToggleBrowserPicker: () => void
  }

  let { prompt = $bindable(), isGenerating, waitingForAnswer, submissionPending, selection,
    selectionAttached = $bindable(), browserContext, codeChanges, changesOpen = $bindable(),
    models, model, reasoningEffort, modelChanging, contextUsedTokens, contextWindowTokens,
    skillPickerEnabled, skills, skillSuggestions, skillOverrides = $bindable(), skillError,
    commands, modelOptionLabel, onSubmit, onModelSelect, onReasoningEffortSelect,
    onRemoveBrowserAttachment, onToggleBrowserPicker }: Props = $props()
  let promptInput = $state<ComposerPrompt>()
  const working = $derived(isGenerating && !waitingForAnswer)
  const contextProgress = $derived(contextWindowTokens === undefined || contextUsedTokens === undefined
    ? 0 : Math.min(100, Math.max(0, (contextUsedTokens / contextWindowTokens) * 100)))
  const contextLabel = $derived(contextWindowTokens === undefined ? 'Context window unavailable'
    : contextUsedTokens === undefined ? `Context window: ${formatTokenCount(contextWindowTokens)} tokens`
      : `Context: ${formatTokenCount(contextUsedTokens)} of ${formatTokenCount(contextWindowTokens)} tokens (${Math.round(contextProgress)}%)`)

  export function focus(): void { promptInput?.focus() }
</script>

<div class="px-[14px] pt-0 pb-[14px]">
  {#if skillPickerEnabled}
    <SkillsDrawer {skills} suggestions={skillSuggestions} overrides={skillOverrides} disabled={submissionPending} error={skillError} onoverride={(value) => { skillOverrides = value }} />
  {/if}
  {#if browserContext?.attachments.length}
    <BrowserAttachments attachments={browserContext.attachments} disabled={isGenerating} onremove={onRemoveBrowserAttachment} />
  {/if}
  {#if selection && selectionAttached}
    <div class="mb-[8px] flex w-fit max-w-full items-center gap-[8px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--composer)] px-[6px] py-[4px] text-[11px] text-[var(--muted-foreground)]">
      <Code2 size={14} strokeWidth={1.7} />
      <div class="flex min-w-0 flex-1 items-center gap-[6px]">
        <div class="min-w-0 flex-[0_1_auto] truncate text-[var(--foreground)]">{selection.fileLabel}</div>
        <span class="flex-none text-[#707070]" aria-hidden="true">·</span>
        <div class="min-w-0 truncate text-[var(--muted-foreground)]">
          {selectionLineLabel(selection)}
          <span class="mx-[4px] flex-none text-[#707070]" aria-hidden="true">·</span>
          {selection.languageId || 'plain text'}
        </div>
      </div>
      <button class="btn h-[24px] w-[24px] p-0" data-variant="ghost" data-size="icon" type="button" aria-label="Remove editor context" title="Remove editor context" onclick={() => { selectionAttached = false }}><X size={14} strokeWidth={1.8} /></button>
    </div>
  {/if}
  {#if codeChanges.length > 0 && isGenerating}
    <ChangesPanel changes={codeChanges} bind:open={changesOpen} variant="drawer" />
  {/if}
  <div class={`relative overflow-visible rounded-[8px] border bg-[var(--composer)] [transition:border-color_.3s_ease,box-shadow_.3s_ease] ${working ? '[border-color:color-mix(in_srgb,var(--brand-gold)_40%,var(--border))] [box-shadow:0_0_12px_color-mix(in_srgb,var(--brand-gold)_12%,transparent)]' : 'border-[var(--border)]'}`}>
    <div aria-hidden="true" class={`pointer-events-none absolute -inset-[3px] rounded-[10px] p-[3px] blur-[3px] [background-image:linear-gradient(110deg,transparent_20%,color-mix(in_srgb,var(--brand-gold)_35%,transparent)_40%,var(--brand-gold)_50%,color-mix(in_srgb,var(--brand-gold)_35%,transparent)_60%,transparent_80%)] [background-size:250%_100%] [background-position:100%_0] [mask-image:linear-gradient(#000_0_0),linear-gradient(#000_0_0)] [mask-origin:content-box,border-box] [mask-clip:content-box,border-box] [mask-composite:exclude] transition-opacity duration-[300ms] ease-[ease] motion-reduce:animate-none motion-reduce:[background-position:50%_0] ${working ? 'animate-composer-shimmer opacity-60' : 'opacity-0'}`}></div>
    <ComposerPrompt
      bind:this={promptInput}
      bind:prompt
      {commands}
      disabled={submissionPending}
      submitBlocked={waitingForAnswer}
      {onSubmit}
    />
    <div class="flex items-center justify-end gap-[8px] px-[8px] pt-[3px] pb-[8px]">
      {#if browserContext?.hasOpenBrowser}
        <span class="mr-auto" data-side="top" data-align="start" data-tooltip={browserContext.picking ? 'Stop selecting browser elements' : browserContext.available ? 'Select browser elements' : 'Browser picker setup required. Use Helix: Select Browser Elements.'}>
          <button class="btn aria-pressed:bg-[var(--accent)] aria-pressed:text-[#60a5fa]!" data-variant="ghost" data-size="icon-sm" type="button" aria-label={browserContext.picking ? 'Stop selecting browser elements' : 'Select browser elements'} aria-pressed={browserContext.picking} disabled={!browserContext.available || (isGenerating && !browserContext.picking)} onclick={onToggleBrowserPicker}><MousePointer2 size={15} strokeWidth={1.8} /></button>
        </span>
      {/if}
      <ComposerModelPicker {models} {model} {reasoningEffort} {modelChanging} {modelOptionLabel} {onModelSelect} {onReasoningEffortSelect} />
      <span id="send-context-description" class="sr-only">{contextLabel}</span>
      <span class="composer-tooltip inline-grid flex-none place-items-center rounded-[calc(var(--radius-md)+2px)] p-[2px] [background:conic-gradient(from_315deg,#d7d7d7_var(--context-progress),#292e33_0)]" style={`--context-progress: ${contextProgress}%`} data-tooltip={contextLabel} data-side="top" data-align="end">
        <button class="btn inline-flex items-center justify-center border border-[#171b1f] bg-[var(--primary)] font-[650]! text-[var(--primary-foreground)]! disabled:bg-[color-mix(in_srgb,var(--primary)_42%,#292e33)] disabled:text-[color-mix(in_srgb,var(--primary-foreground)_42%,#292e33)]! disabled:opacity-100!" data-size="icon-sm" type="button" aria-label={isGenerating || waitingForAnswer ? 'Stop generation' : 'Send message'} aria-describedby="send-context-description" onclick={onSubmit} disabled={!isGenerating && !waitingForAnswer && !prompt.trim()}>
          {#if isGenerating || waitingForAnswer}<Square size={13} strokeWidth={1.8} />{:else}<ArrowUp size={14} strokeWidth={1.8} />{/if}
        </button>
      </span>
    </div>
  </div>
</div>
