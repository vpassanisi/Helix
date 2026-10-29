<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import Composer from '../../src/webview/components/Composer.svelte'
  import Transcript from '../../src/webview/components/Transcript.svelte'
  import { ChatTranscript } from '../../src/webview/lib/chat-transcript.svelte.js'
  import { ComposerCommandState } from '../../src/webview/lib/composer-commands.svelte.js'
  import { preferredReasoningEffort } from '../../src/runtime/model-catalog.js'
  import { commandCatalog } from '../fixtures.js'
  import type { ChatMessage } from '../../src/webview/types.js'
  type Args = ComponentProps<typeof Composer> & { messages?: ChatMessage[] }
  let { args }: { args: Args } = $props()
  let prompt = $state('')
  let selectionAttached = $state(true)
  let changesOpen = $state(false)
  let skillOverrides = $state<Args['skillOverrides']>({ include: [], exclude: [] })
  let model = $state('')
  let reasoningEffort = $state<string | null>(null)
  let isGenerating = $state(false)
  let waitingForAnswer = $state(false)
  let browserContext = $state<Args['browserContext']>()
  const commands = new ComposerCommandState(() => undefined, () => 'preview')
  commands.applyCatalog(commandCatalog)
  // In the canvas the caret is the end of the draft, which is where typing leaves it.
  $effect(() => { commands.sync(prompt, prompt.length) })
  $effect(() => {
    prompt = args.prompt
    selectionAttached = args.selectionAttached
    changesOpen = args.changesOpen
    skillOverrides = structuredClone($state.snapshot(args.skillOverrides))
    model = args.model
    reasoningEffort = args.reasoningEffort
    isGenerating = args.isGenerating
    waitingForAnswer = args.waitingForAnswer
    browserContext = args.browserContext ? structuredClone($state.snapshot(args.browserContext)) : undefined
  })

  // With a chat history the container gets a fixed height, so the transcript
  // scrolls and the composer stays pinned to the bottom of the sidebar.
  const transcript = new ChatTranscript(() => {})
  $effect(() => { transcript.messages = structuredClone($state.snapshot(args.messages ?? [])) })
  let hasHistory = $derived((args.messages?.length ?? 0) > 0)
</script>

<div class="composer-story mx-[-14px] flex flex-col {hasHistory ? 'composer-story-history relative h-[520px] overflow-hidden' : 'min-h-[520px] justify-end'}">
  {#if hasHistory}
    <!-- The transcript fills the whole container; the composer floats over it
         so the history scrolls behind the (transparent) composer padding. -->
    <div class="absolute inset-0 flex flex-col">
      <Transcript
        {transcript}
        activeSessionId="preview"
        isGenerating={args.isGenerating}
        waitingForFirstResponse={false}
        codeChanges={args.codeChanges}
        changesOpen={false}
        onanswer={() => {}}
        onapprove={() => {}}
        onui={() => {}}
      />
    </div>
  {/if}
  <div class={hasHistory ? 'absolute inset-x-0 bottom-0' : ''}>
  <Composer {...args} bind:prompt bind:selectionAttached bind:changesOpen bind:skillOverrides {model} {reasoningEffort} {isGenerating} {waitingForAnswer} {commands} {browserContext}
    onSubmit={() => {
      args.onSubmit()
      if (isGenerating || waitingForAnswer) { isGenerating = false; waitingForAnswer = false }
      else if (commands.invocation(prompt)) { prompt = ''; commands.close() }
      else { prompt = ''; isGenerating = true }
    }}
    onModelSelect={(id) => {
      args.onModelSelect(id)
      model = id
      reasoningEffort = preferredReasoningEffort(args.models.find((entry) => entry.id === id)) ?? null
    }}
    onReasoningEffortSelect={(effort) => { args.onReasoningEffortSelect(effort); reasoningEffort = effort }}
    onRemoveBrowserAttachment={(id) => {
      args.onRemoveBrowserAttachment(id)
      if (browserContext) browserContext = { ...browserContext, attachments: browserContext.attachments.filter((entry) => entry.id !== id) }
    }}
    onToggleBrowserPicker={() => {
      args.onToggleBrowserPicker()
      if (browserContext) browserContext = { ...browserContext, picking: !browserContext.picking }
    }} />
  </div>
</div>
