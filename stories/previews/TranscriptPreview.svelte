<script lang="ts">
  import Transcript from '../../src/webview/components/Transcript.svelte'
  import { ChatTranscript } from '../../src/webview/lib/chat-transcript.svelte.js'
  import type { ChatMessage, CodeChange } from '../../src/webview/types.js'

  interface Props {
    messages: ChatMessage[]
    isGenerating: boolean
    waitingForFirstResponse: boolean
    codeChanges: CodeChange[]
  }

  let { messages, isGenerating = false, waitingForFirstResponse = false, codeChanges = [] }: Props = $props()

  const transcript = new ChatTranscript(() => {})
  $effect(() => { transcript.messages = structuredClone($state.snapshot(messages)) })
</script>

<div class="chat-view h-[320px]">
  <Transcript
    {transcript}
    activeSessionId="preview"
    {isGenerating}
    {waitingForFirstResponse}
    {codeChanges}
    changesOpen={false}
    onanswer={() => {}}
    onapprove={() => {}}
  />
</div>
