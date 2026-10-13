<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import ThinkingCard from '../src/webview/components/ThinkingCard.svelte'

  const text = 'The request touches the session controller and the webview. I am tracing both paths before making the change so the UI stays in sync with the runtime.'
  const { Story } = defineMeta({
    title: 'Chat/ThinkingCard',
    component: ThinkingCard,
    args: { label: 'Thinking', text, active: false },
    argTypes: { active: { control: 'boolean' } },
  })
</script>

<Story name="Completed" />
<Story name="Active" args={{ active: true }} />
<Story name="Long reasoning" args={{ text: `${text}\n\n${text}\n\n${text}` }} />
