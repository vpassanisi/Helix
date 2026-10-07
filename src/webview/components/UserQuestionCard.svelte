<script lang="ts">
  import { optionDisplayLabel, type UserQuestionAnswer, type UserQuestionView } from '../../shared/user-question.js'

  let { value, onanswer }: { value: UserQuestionView; onanswer: (answer: UserQuestionAnswer) => void } = $props()
  let selected = $state('')
  let custom = $state('')
  const pending = $derived(value.status === 'pending' || value.status === 'submitting')
  const submitting = $derived(value.status === 'submitting')
  const ready = $derived(selected === 'custom' ? custom.trim().length > 0 : selected !== '')

  function submit(event: SubmitEvent): void {
    event.preventDefault()
    if (!ready || !pending || submitting) return
    onanswer(selected === 'custom'
      ? { id: value.question.id, selected: [], custom: custom.trim() }
      : { id: value.question.id, selected: [value.question.options[Number(selected)].label] })
  }
</script>

<section class="card user-question" aria-label="Agent question" data-question-request={value.requestId}>
  {#if value.question.header}<div class="question-heading">{value.question.header}</div>{/if}
  <p class="question-prompt" id={`question-${value.requestId}`}>{value.question.question}</p>
  {#if pending}
    <form onsubmit={submit}>
      <fieldset disabled={submitting} aria-labelledby={`question-${value.requestId}`}>
        {#each value.question.options as option, index (`${index}:${option.label}`)}
          <label class="question-option">
            <input class="input" type="radio" name={`answer-${value.requestId}`} value={String(index)} bind:group={selected} />
            <span class="question-option-copy">
              <span class="question-option-label">{optionDisplayLabel(option.label)}{#if index === 0}<span class="badge" data-variant="secondary">Recommended</span>{/if}</span>
              {#if option.description}<span class="question-description">{option.description}</span>{/if}
            </span>
          </label>
        {/each}
        <label class="question-option">
          <input class="input" type="radio" name={`answer-${value.requestId}`} value="custom" bind:group={selected} />
          <span>Custom response</span>
        </label>
        {#if selected === 'custom'}
          <textarea class="textarea" aria-label="Custom response" bind:value={custom} rows="2" placeholder="Type your answer…"></textarea>
        {/if}
      </fieldset>
      {#if value.error}<p class="question-error" role="alert">{value.error}</p>{/if}
      <div class="question-footer">
        <span role="status">{submitting ? 'Sending answer…' : 'Waiting for your answer'}</span>
        <button class="btn" data-size="xs" type="submit" disabled={!ready || submitting}>Submit answer</button>
      </div>
    </form>
  {:else if value.status === 'answered' && value.answer}
    <p class="question-answer"><span>Your answer</span>{value.answer.custom ?? optionDisplayLabel(value.answer.selected[0] ?? '')}</p>
  {:else}
    <p class="question-ended" role="status">{value.status === 'unavailable' ? 'Question unavailable' : 'Question cancelled'}</p>
  {/if}
</section>

<style>
  .user-question { gap: 0; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--composer); font-size: 11px; }
  .question-heading { margin-bottom: 4px; font-size: 10px; color: var(--muted-foreground); }
  .question-prompt { margin: 0 0 8px; overflow-wrap: anywhere; font-weight: 600; }
  fieldset { display: grid; min-width: 0; gap: 6px; padding: 0; margin: 0; border: 0; }
  .question-option { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
  .question-option input { flex: 0 0 auto; margin-top: 2px; }
  .question-option-copy { min-width: 0; }
  .question-option-label { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; overflow-wrap: anywhere; }
  .badge { padding: 1px 5px; font-size: 9px; }
  .question-description { display: block; margin-top: 2px; color: var(--muted-foreground); overflow-wrap: anywhere; }
  textarea { width: 100%; min-height: 52px; resize: vertical; font-size: 11px; }
  .question-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; }
  .question-footer > span, .question-ended { color: var(--muted-foreground); font-size: 10px; }
  .question-footer button { color: var(--primary-foreground); }
  .question-error { color: var(--destructive); overflow-wrap: anywhere; }
  .question-answer { display: grid; gap: 3px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .question-answer > span { color: var(--muted-foreground); font-size: 10px; }
  .question-ended { margin: 0; }
</style>
