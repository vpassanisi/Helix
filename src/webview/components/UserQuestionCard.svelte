<script lang="ts">
  import { ArrowUp } from '@lucide/svelte'
  import { optionDisplayLabel, type UserQuestionAnswer, type UserQuestionView } from '../../shared/user-question.js'

  let { value, onanswer }: { value: UserQuestionView; onanswer: (answer: UserQuestionAnswer) => void } = $props()
  let custom = $state('')
  const pending = $derived(value.status === 'pending' || value.status === 'submitting')
  const submitting = $derived(value.status === 'submitting')
  const ready = $derived(custom.trim().length > 0)

  function submitOption(label: string): void {
    if (!pending || submitting) return
    onanswer({ id: value.question.id, selected: [label] })
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault()
    if (!ready || !pending || submitting) return
    onanswer({ id: value.question.id, selected: [], custom: custom.trim() })
  }
</script>

<section class={`card relative gap-0 overflow-visible border rounded-[8px] bg-[var(--composer)] p-[10px] text-[11px] [transition:border-color_.3s_ease,box-shadow_.3s_ease] ${pending ? '[border-color:color-mix(in_srgb,var(--brand-gold)_40%,var(--border))] [box-shadow:0_0_12px_color-mix(in_srgb,var(--brand-gold)_12%,transparent)]' : 'border-[var(--border)]'}`} aria-label="Agent question" data-question-request={value.requestId}>
  {#if pending}
    <div aria-hidden="true" class="pointer-events-none absolute -inset-[3px] rounded-[10px] p-[3px] blur-[3px] [background-image:linear-gradient(110deg,transparent_20%,color-mix(in_srgb,var(--brand-gold)_35%,transparent)_40%,var(--brand-gold)_50%,color-mix(in_srgb,var(--brand-gold)_35%,transparent)_60%,transparent_80%)] [background-size:250%_100%] [background-position:100%_0] [mask-image:linear-gradient(#000_0_0),linear-gradient(#000_0_0)] [mask-origin:content-box,border-box] [mask-clip:content-box,border-box] [mask-composite:exclude] animate-composer-shimmer opacity-60 motion-reduce:animate-none motion-reduce:[background-position:50%_0]"></div>
  {/if}
  {#if value.question.header}<div class="mb-[4px] text-[10px] text-[var(--muted-foreground)]">{value.question.header}</div>{/if}
  <p class="m-0 mb-[8px] [overflow-wrap:anywhere] font-semibold" id={`question-${value.requestId}`}>{value.question.question}</p>
  {#if pending}
    <form onsubmit={submit} aria-busy={submitting}>
      <fieldset class="grid min-w-0 gap-[6px] border-0 p-0 m-0" disabled={submitting} aria-labelledby={`question-${value.requestId}`}>
        {#each value.question.options as option, index (`${index}:${option.label}`)}
          <button class="btn flex w-full h-auto items-start justify-start px-[6px] py-[4px] [font:inherit] text-left whitespace-normal cursor-pointer" data-variant="ghost" type="button" onclick={() => submitOption(option.label)}>
            <span class="block min-w-0">
              <span class="flex flex-wrap items-center gap-[6px] [overflow-wrap:anywhere]">{optionDisplayLabel(option.label)}{#if index === 0}<span class="badge px-[5px] py-px text-[9px]" data-variant="secondary">Recommended</span>{/if}</span>
              {#if option.description}<span class="block mt-[2px] text-[var(--muted-foreground)] [overflow-wrap:anywhere]">{option.description}</span>{/if}
            </span>
          </button>
        {/each}
        <div class="overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--composer)]">
          <textarea class="textarea w-full min-h-[32px] max-h-[180px] resize-none rounded-none border-0 bg-transparent text-[11px] focus:border-transparent focus:[box-shadow:none] focus-visible:[box-shadow:none] focus:outline-none! focus:outline-offset-0! focus-visible:outline-none! focus-visible:outline-offset-0!" aria-label="Custom response" bind:value={custom} rows="1" placeholder="Type your answer…"></textarea>
          <div class="flex items-center justify-end px-[8px] pt-[3px] pb-[8px]">
            <button class="btn inline-flex items-center justify-center border border-[#171b1f] bg-[var(--primary)] text-[var(--primary-foreground)]! disabled:bg-[color-mix(in_srgb,var(--primary)_42%,#292e33)] disabled:text-[color-mix(in_srgb,var(--primary-foreground)_42%,#292e33)]! disabled:opacity-100!" data-size="icon-sm" type="submit" aria-label="Submit custom response" title="Submit custom response" disabled={!ready || submitting}><ArrowUp size={14} strokeWidth={1.8} /></button>
          </div>
        </div>
      </fieldset>
      {#if value.error}<p class="text-[var(--destructive)] [overflow-wrap:anywhere]" role="alert">{value.error}</p>{/if}
      {#if submitting}<span class="sr-only" role="status">Sending answer…</span>{/if}
    </form>
  {:else if value.status === 'answered' && value.answer}
    <p class="m-0 grid gap-[3px] whitespace-pre-wrap [overflow-wrap:anywhere]"><span class="text-[10px] text-[var(--muted-foreground)]">Your answer</span>{value.answer.custom ?? optionDisplayLabel(value.answer.selected[0] ?? '')}</p>
  {:else}
    <p class="m-0 text-[10px] text-[var(--muted-foreground)]" role="status">{value.status === 'unavailable' ? 'Question unavailable' : 'Question cancelled'}</p>
  {/if}
</section>
