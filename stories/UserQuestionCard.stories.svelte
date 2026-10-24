<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import UserQuestionCard from '../src/webview/components/UserQuestionCard.svelte'
  import Preview from './previews/UserQuestionPreview.svelte'
  import { question, planReview } from './fixtures.js'

  const { Story } = defineMeta({
    title: 'Chat/UserQuestionCard', component: UserQuestionCard, render: template,
    args: { value: question, onanswer: fn() },
  })
</script>

{#snippet template(args: ComponentProps<typeof UserQuestionCard>)}
  <Preview {args} />
{/snippet}

<Story name="Pending" />
<Story name="Submitting" args={{ value: { ...question, status: 'submitting' } }} />
<Story name="Answered" args={{ value: { ...question, status: 'answered', answer: { id: 'scope', selected: ['Current component (Recommended)'] } } }} />
<Story name="Answered Custom" args={{ value: { ...question, status: 'answered', answer: { id: 'scope', selected: [], custom: 'Only the styles and the card header.' } } }} />
<Story name="Cancelled" args={{ value: { ...question, status: 'cancelled' } }} />
<Story name="Plan review" args={{ value: planReview }} />
<Story name="Plan accepted" args={{ value: { ...planReview, status: 'answered', answer: { id: 'plan-review', selected: ['Approve'] } } }} />
<Story name="Plan feedback sent" args={{ value: { ...planReview, status: 'answered', answer: { id: 'plan-review', selected: [], custom: 'Give the version bump its own step, and keep the 14px gutter.' } } }} />
<Story name="Plan cancelled" args={{ value: { ...planReview, status: 'cancelled' } }} />
