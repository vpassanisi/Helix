<script lang="ts">
  import { ArrowUp } from '@lucide/svelte'
  import { optionDisplayLabel, type UserQuestionAnswer, type UserQuestionView } from '../../shared/user-question.js'
  import { renderMarkdown } from '../markdown.js'

  let { value, onanswer }: { value: UserQuestionView; onanswer: (answer: UserQuestionAnswer) => void } = $props()
  let custom = $state('')
  const plan = $derived(value.question.intent === 'plan-review')
  const pending = $derived(value.status === 'pending' || value.status === 'submitting')
  const submitting = $derived(value.status === 'submitting')
  const ready = $derived(custom.trim().length > 0)
  /** The asker's label travels on the wire; the button says what it does. */
  const approveLabel = $derived(value.question.approveLabel ?? value.question.options[0]?.label ?? 'Approve')
  const accepted = $derived(value.answer?.selected[0] === approveLabel)
  const answerText = $derived(value.answer?.custom ?? (accepted ? 'Accept and implement' : optionDisplayLabel(value.answer?.selected[0] ?? '')))
  const answerDescription = $derived(value.answer?.custom || accepted
    ? ''
    : value.question.options.find((option) => option.label === value.answer?.selected[0])?.description ?? '')

  function submitOption(label: string): void {
    if (!pending || submitting) return
    onanswer({ id: value.question.id, selected: [label] })
  }

  function sendCustom(): void {
    if (!ready || !pending || submitting) return
    onanswer({ id: value.question.id, selected: [], custom: custom.trim() })
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault()
    sendCustom()
  }

  /**
   * Enter answers and Shift+Enter breaks the line, as in the composer. The
   * textarea inserts its own newline, so only Enter needs a handler.
   */
  function handleKeydown(event: KeyboardEvent): void {
    // An IME in the middle of composing owns Enter: the text is not final yet.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    sendCustom()
  }
</script>

<section class={`card relative gap-0 overflow-visible border rounded-[8px] bg-[var(--composer)] p-[10px] text-[11px] [transition:border-color_.3s_ease,box-shadow_.3s_ease] ${pending ? '[border-color:color-mix(in_srgb,var(--brand-gold)_40%,var(--border))] [box-shadow:0_0_12px_color-mix(in_srgb,var(--brand-gold)_12%,transparent)]' : 'border-[var(--border)]'}`} aria-label={plan ? 'Plan review' : 'Agent question'} data-question-request={value.requestId}>
  {#if pending}
    <div aria-hidden="true" class="pointer-events-none absolute -inset-[3px] rounded-[10px] p-[3px] blur-[3px] [background-image:linear-gradient(110deg,transparent_20%,color-mix(in_srgb,var(--brand-gold)_35%,transparent)_40%,var(--brand-gold)_50%,color-mix(in_srgb,var(--brand-gold)_35%,transparent)_60%,transparent_80%)] [background-size:250%_100%] [background-position:100%_0] [mask-image:linear-gradient(#000_0_0),linear-gradient(#000_0_0)] [mask-origin:content-box,border-box] [mask-composite:exclude] animate-composer-shimmer opacity-60 motion-reduce:animate-none motion-reduce:[background-position:50%_0]"></div>
  {/if}
  {#if plan}<div class="mb-[4px] text-[10px] tracking-[.08em] uppercase text-[var(--muted-foreground)]">{value.question.header ?? 'Plan review'}</div>{/if}
  {#if value.question.header && !plan}<div class="mb-[4px] text-[10px] text-[var(--muted-foreground)]">{value.question.header}</div>{/if}
  {#if plan}
    <div class="markdown wrap-anywhere mb-[8px] p-[8px] text-[11px] leading-[1.5] [font-family:inherit]">{@html renderMarkdown(value.question.detail ?? '')}</div>
  {:else}
    <p class="m-0 mb-[8px] [overflow-wrap:anywhere] font-semibold" id={`question-${value.requestId}`}>{value.question.question}</p>
  {/if}
  {#if pending}
    <form onsubmit={submit} aria-busy={submitting}>
      <fieldset class="grid min-w-0 gap-[6px] border-0 p-0 m-0" disabled={submitting} aria-labelledby={plan ? undefined : `question-${value.requestId}`}>
        {#if plan}
          <button class="btn flex w-full h-[28px] items-center justify-center border border-[#171b1f] bg-[var(--primary)] text-[var(--primary-foreground)]! font-semibold disabled:bg-[color-mix(in_srgb,var(--primary)_42%,#292e33)] disabled:text-[color-mix(in_srgb,var(--primary-foreground)_42%,#292e33)]! disabled:opacity-100!" data-size="sm" type="button" onclick={() => submitOption(approveLabel)}>Accept and implement</button>
        {:else}
          {#each value.question.options as option, index (`${index}:${option.label}`)}
            <button class="btn flex w-full h-auto items-start justify-start rounded-[8px] px-[6px] py-[4px] [font:inherit] text-left whitespace-normal cursor-pointer" data-variant="ghost" type="button" onclick={() => submitOption(option.label)}>
              <span class="block min-w-0">
                <span class="flex flex-wrap items-center gap-[6px] [overflow-wrap:anywhere]">{optionDisplayLabel(option.label)}{#if index === 0}<span class="badge px-[5px] py-px text-[9px]" data-variant="secondary">Recommended</span>{/if}</span>
                {#if option.description}<span class="block mt-[2px] text-[var(--muted-foreground)] [overflow-wrap:anywhere]">{option.description}</span>{/if}
              </span>
            </button>
          {/each}
        {/if}
        <div class="overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--composer)]">
          <textarea class="textarea w-full min-h-[32px] max-h-[180px] resize-none rounded-none border-0 bg-transparent text-[11px] focus:border-transparent focus:[box-shadow:none] focus-visible:[box-shadow:none] focus:outline-none! focus:outline-offset-0! focus-visible:outline-none! focus-visible:outline-offset-0!" aria-label={plan ? 'Ask for changes to the plan' : 'Custom response'} aria-keyshortcuts="Enter Shift+Enter" bind:value={custom} rows="1" placeholder={plan ? 'Ask for changes, or add what the plan is missing…' : 'Type your answer…'} onkeydown={handleKeydown}></textarea>
          <div class="flex items-center justify-end px-[8px] pt-[3px] pb-[8px]">
            <button class="btn inline-flex items-center justify-center border border-[#171b1f] bg-[var(--primary)] text-[var(--primary-foreground)]! disabled:bg-[color-mix(in_srgb,var(--primary)_42%,#292e33)] disabled:text-[color-mix(in_srgb,var(--primary-foreground)_42%,#292e33)]! disabled:opacity-100!" data-size="icon-sm" type="submit" aria-label={plan ? 'Send plan feedback' : 'Submit custom response'} title={plan ? 'Send plan feedback' : 'Submit custom response'} disabled={!ready || submitting}><ArrowUp size={14} strokeWidth={1.8} /></button>
          </div>
        </div>
      </fieldset>
      {#if value.error}<p class="text-[var(--destructive)] [overflow-wrap:anywhere]" role="alert">{value.error}</p>{/if}
      {#if submitting}<span class="sr-only" role="status">Sending answer…</span>{/if}
    </form>
  {:else if value.status === 'answered' && value.answer}
    <p class="m-0 grid gap-[3px] [overflow-wrap:anywhere]"><span class="text-[10px] text-[var(--muted-foreground)]">{plan ? (accepted ? 'Plan accepted' : 'Feedback sent') : 'Your answer'}</span><span class="whitespace-pre-wrap">{answerText}</span>{#if answerDescription}<span class="whitespace-pre-wrap text-[var(--muted-foreground)]">{answerDescription}</span>{/if}</p>
  {:else}
    <p class="m-0 text-[10px] text-[var(--muted-foreground)]" role="status">{value.status === 'unavailable' ? `${plan ? 'Plan review' : 'Question'} unavailable` : plan ? 'Plan review cancelled' : 'Question cancelled'}</p>
  {/if}
</section>
