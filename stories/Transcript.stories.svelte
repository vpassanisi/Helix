<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import type { ComponentProps } from 'svelte'
  import Preview from './previews/TranscriptPreview.svelte'
  import { changes, chatMessages, planCommandMessage, planRuleMessage, planRuleOffMessage, questionMessage, uiCardMessage } from './fixtures.js'

  const args: ComponentProps<typeof Preview> = {
    messages: chatMessages, isGenerating: false, waitingForFirstResponse: false, codeChanges: [],
  }

  const { Story } = defineMeta({ title: 'Chat/Transcript', component: Preview, args })
</script>

<Story name="All message kinds" />
<Story name="Waiting for model" args={{ messages: chatMessages.slice(0, 1), isGenerating: true, waitingForFirstResponse: true }} />
<Story name="Live changes" args={{ messages: chatMessages.slice(0, 3), codeChanges: changes }} />
<Story name="Question pending" args={{ messages: [chatMessages[0], questionMessage], isGenerating: true }} />
<Story name="Card in the transcript" args={{ messages: [chatMessages[0], chatMessages[2], uiCardMessage, chatMessages[4]] }} />
<Story name="Plan mode" args={{ messages: [planCommandMessage, planRuleMessage, chatMessages[2], planRuleOffMessage, chatMessages[3]] }} />
