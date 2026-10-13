<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import UserQuestionCard from '../src/webview/components/UserQuestionCard.svelte'
  import Preview from './previews/UserQuestionPreview.svelte'
  import { question } from './fixtures.js'

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
<Story name="Cancelled" args={{ value: { ...question, status: 'cancelled' } }} />
