<script lang="ts">
  import { Code2, MousePointer2 } from '@lucide/svelte'
  import ChangesPanel from './ChangesPanel.svelte'
  import CompactionCard from './CompactionCard.svelte'
  import ModeRule from './ModeRule.svelte'
  import ThinkingCard from './ThinkingCard.svelte'
  import ToolCallCard from './ToolCallCard.svelte'
  import UserQuestionCard from './UserQuestionCard.svelte'
  import { renderMarkdown } from '../markdown.js'
  import { selectionLineLabel } from '../formatting.js'
  import type { UserQuestionAnswer } from '../../shared/user-question.js'
  import type { ChatMessage } from '../types.js'

  interface Props {
    message: ChatMessage
    activeSessionId: string
    /** True while this reasoning block is the live one from the current turn. */
    thinking: boolean
    onanswer: (answer: UserQuestionAnswer) => void
    onapprove: (outcome: 'allowed-once' | 'rejected') => void
  }

  let { message, activeSessionId, thinking, onanswer, onapprove }: Props = $props()
</script>

{#if message.role === 'changes' && message.changes}
  <ChangesPanel changes={message.changes} bind:open={message.panelOpen} variant="summary" />
{:else}
  <article class="message" class:user={message.role === 'user'} class:assistant={message.role === 'assistant'} class:reasoning={message.role === 'reasoning'} class:activity={message.role === 'activity'} class:tool={message.role === 'tool'} class:divider={message.role === 'divider'}>
    {#if message.role === 'divider'}
      <ModeRule label={message.text} />
    {:else if message.role === 'compaction' && message.compaction}
      <CompactionCard entry={message.compaction} subagent={message.compaction.sessionId !== activeSessionId} />
    {:else if message.role === 'reasoning'}
      <ThinkingCard label={message.label} text={message.text} active={thinking} />
    {:else if message.role === 'tool' && message.tool}
      {#if message.tool.question}
        <UserQuestionCard value={message.tool.question} {onanswer} />
      {:else}
        <ToolCallCard tool={message.tool} {onapprove} />
      {/if}
    {:else}
      {#if message.role === 'user' && message.context}
        <div class="message-context" title={`${message.context.fileLabel} · ${selectionLineLabel(message.context)}`}>
          <Code2 size={12} strokeWidth={1.7} />
          <span class="message-context-file">{message.context.fileLabel}</span>
          <span class="message-context-lines">{selectionLineLabel(message.context)}</span>
        </div>
      {/if}
      {#if message.role === 'user' && message.browserLabels?.length}
        <div class="message-context" aria-label="Attached browser elements">
          <MousePointer2 size={12} />
          <span class="message-context-file">{message.browserLabels.join(', ')}</span>
        </div>
      {/if}
      {#if message.role === 'assistant'}
        <div class="message-body markdown">{@html renderMarkdown(message.text)}</div>
      {:else if message.role === 'user' && message.html}
        <div class="message-body">{@html message.html}</div>
      {:else}
        <div class="message-body">{message.text}</div>
      {/if}
    {/if}
  </article>
{/if}
