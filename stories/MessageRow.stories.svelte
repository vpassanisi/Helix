<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import MessageRow from '../src/webview/components/MessageRow.svelte'
  import { chatMessages, planCommandMessage, planRuleMessage, planRuleOffMessage, questionMessage } from './fixtures.js'

  const { Story } = defineMeta({
    title: 'Chat/MessageRow', component: MessageRow,
    args: { message: chatMessages[0], activeSessionId: 'preview', thinking: false, onanswer: fn(), onapprove: fn() },
  })
</script>

<Story name="User" />
<Story name="Reasoning active" args={{ message: chatMessages[1], thinking: true }} />
<Story name="Assistant" args={{ message: chatMessages[2] }} />
<Story name="Tool" args={{ message: chatMessages[3] }} />
<Story name="Activity" args={{ message: chatMessages[4] }} />
<Story name="Compaction" args={{ message: chatMessages[5] }} />
<Story name="Changes" args={{ message: chatMessages[6] }} />
<Story name="Question" args={{ message: questionMessage }} />
<Story name="Plan command" args={{ message: planCommandMessage }} />
<Story name="Plan mode rule" args={{ message: planRuleMessage }} />
<Story name="Plan mode rule off" args={{ message: planRuleOffMessage }} />
