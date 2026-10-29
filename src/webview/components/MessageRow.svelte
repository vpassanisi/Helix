<script lang="ts">
  import { Code2, MousePointer2 } from '@lucide/svelte'
  import ChangesPanel from './ChangesPanel.svelte'
  import CompactionCard from './CompactionCard.svelte'
  import ModeRule from './ModeRule.svelte'
  import ThinkingCard from './ThinkingCard.svelte'
  import ToolCallCard from './ToolCallCard.svelte'
  import UserQuestionCard from './UserQuestionCard.svelte'
  import GenUiCard from './GenUiCard.svelte'
  import { renderMarkdown } from '../markdown.js'
  import { selectionLineLabel } from '../formatting.js'
  import type { GenUiAction } from '../../shared/gen-ui.js'
  import type { UserQuestionAnswer } from '../../shared/user-question.js'
  import type { ChatMessage } from '../types.js'

  interface Props {
    message: ChatMessage
    activeSessionId: string
    /** True while this reasoning block is the live one from the current turn. */
    thinking: boolean
    onanswer: (answer: UserQuestionAnswer) => void
    onapprove: (outcome: 'allowed-once' | 'rejected') => void
    onui: (action: GenUiAction) => void
  }

  let { message, activeSessionId, thinking, onanswer, onapprove, onui }: Props = $props()

  /** Shared row behaviour: a bottom gap and the settle-in animation. */
  const rowBase = 'mb-3.5 animate-enter'
  /** Per-role row styling, replacing the old `.message.<role>` rules. */
  const rowRoleClasses: Record<string, string> = {
    reasoning: 'px-2.5 text-[11px] text-[var(--muted-foreground)]',
    activity: 'border-l border-[var(--border)] pl-2.5 text-[11px] text-[var(--muted-foreground)]',
    tool: 'px-2.5 text-[11px] text-[var(--muted-foreground)]',
  }
  const rowClass = $derived(
    message.role === 'divider' ? 'animate-enter mt-1 mb-4.5' : `${rowBase} ${rowRoleClasses[message.role] ?? ''}`.trim(),
  )
  /** The message text box; user lines sit on the right, assistant lines are inset.
      Assistant lines are rendered markdown, so the `markdown` utility owns their
      white-space/line-height. Applying `whitespace-pre-wrap`/`leading-[1.5]` to
      that same element would win the cascade over the utility (equal specificity,
      later in the sheet) and re-expose the source's line breaks as blank space, so
      the assistant box only adds overflow-wrap. Plain-text and user lines keep
      pre-wrap and their own line-height. */
  const bodyClass = $derived(
    [
      message.role === 'assistant'
        ? '[overflow-wrap:anywhere]'
        : 'whitespace-pre-wrap [overflow-wrap:anywhere] leading-[1.5]',
      message.role === 'user'
        ? 'ml-[33.3333%] border border-[var(--border)] rounded-lg bg-[var(--composer)] px-2.5 py-[9px]'
        : message.role === 'assistant' ? 'px-2.5' : '',
    ].filter(Boolean).join(' '),
  )
  /** Element-level styling for rendered markdown. The subtree rules live in the
      `markdown` Tailwind utility in app.css: a plain class name is detected
      reliably by the build, unlike a long string of arbitrary variants. */
  const markdownClass = 'markdown'
  /** A context chip above a user line, hugging the line's left offset. */
  const contextClass =
    'flex w-fit min-w-0 max-w-[66.6667%] items-center gap-1.5 ml-[33.3333%] mb-[5px] px-2 py-[5px] ' +
    'border border-[var(--border)] rounded-[var(--radius)] text-[var(--muted-foreground)] bg-[var(--composer)] text-[10px]'
  const contextFileClass = 'min-w-0 overflow-hidden text-ellipsis text-[#cfcfcf] whitespace-nowrap'
  const contextLinesClass = 'flex-none text-[#8f8f8f] whitespace-nowrap'
</script>

{#if message.role === 'changes' && message.changes}
  <ChangesPanel changes={message.changes} bind:open={message.panelOpen} variant="summary" />
{:else}
  <article class={rowClass}>
    {#if message.role === 'divider'}
      <ModeRule label={message.text} />
    {:else if message.role === 'compaction' && message.compaction}
      <CompactionCard entry={message.compaction} subagent={message.compaction.sessionId !== activeSessionId} />
    {:else if message.role === 'reasoning'}
      <ThinkingCard label={message.label} text={message.text} active={thinking} />
    {:else if message.role === 'ui' && message.ui}
      <GenUiCard view={message.ui} {onui} />
    {:else if message.role === 'tool' && message.tool}
      {#if message.tool.question}
        <UserQuestionCard value={message.tool.question} {onanswer} />
      {:else}
        <ToolCallCard tool={message.tool} {onapprove} />
      {/if}
    {:else}
      {#if message.role === 'user' && message.context}
        <div class={contextClass} title={`${message.context.fileLabel} · ${selectionLineLabel(message.context)}`}>
          <Code2 size={12} strokeWidth={1.7} />
          <span class={contextFileClass}>{message.context.fileLabel}</span>
          <span class={contextLinesClass}>{selectionLineLabel(message.context)}</span>
        </div>
      {/if}
      {#if message.role === 'user' && message.browserLabels?.length}
        <div class={contextClass} aria-label="Attached browser elements">
          <MousePointer2 size={12} />
          <span class={contextFileClass}>{message.browserLabels.join(', ')}</span>
        </div>
      {/if}
      {#if message.role === 'assistant'}
        <div class={`${bodyClass} ${markdownClass}`}>{@html renderMarkdown(message.text)}</div>
      {:else if message.role === 'user' && message.html}
        <div class={bodyClass}>{@html message.html}</div>
      {:else}
        <div class={bodyClass}>{message.text}</div>
      {/if}
    {/if}
  </article>
{/if}
