<script lang="ts">
  import { LoaderCircle } from '@lucide/svelte'
  import ChangesPanel from './ChangesPanel.svelte'
  import MessageRow from './MessageRow.svelte'
  import type { ChatTranscript } from '../lib/chat-transcript.svelte.js'
  import type { GenUiAction } from '../../shared/gen-ui.js'
  import type { UserQuestionAnswer } from '../../shared/user-question.js'
  import type { ChatMessage, CodeChange } from '../types.js'

  interface Props {
    transcript: ChatTranscript
    activeSessionId: string
    isGenerating: boolean
    waitingForFirstResponse: boolean
    codeChanges: CodeChange[]
    changesOpen: boolean
    onanswer: (message: ChatMessage, answer: UserQuestionAnswer) => void
    onapprove: (message: ChatMessage, outcome: 'allowed-once' | 'rejected') => void
    onui: (message: ChatMessage, action: GenUiAction) => void
  }

  let { transcript, activeSessionId, isGenerating, waitingForFirstResponse, codeChanges, changesOpen = $bindable(false), onanswer, onapprove, onui }: Props = $props()
</script>

<div class="transcript" bind:this={transcript.transcriptElement} onscroll={(event) => transcript.onScroll(event)} aria-live="polite">
  {#each transcript.messages as message (message.id)}
    <MessageRow
      {message}
      {activeSessionId}
      thinking={isGenerating && !transcript.waitingForAnswer && transcript.activeThinkingId === message.id}
      onanswer={(answer) => onanswer(message, answer)}
      onapprove={(outcome) => onapprove(message, outcome)}
      onui={(action) => onui(message, action)}
    />
  {/each}
  {#if waitingForFirstResponse}
    <article class="message activity waiting-for-response" role="status">
      <LoaderCircle class="spin" size={13} strokeWidth={1.8} aria-hidden="true" />
      <span>Waiting for the model…</span>
    </article>
  {/if}
  {#if codeChanges.length > 0 && !isGenerating}
    <ChangesPanel changes={codeChanges} bind:open={changesOpen} variant="summary" />
  {/if}
</div>
