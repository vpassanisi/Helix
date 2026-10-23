<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import Composer from '../../src/webview/components/Composer.svelte'
  import { ComposerCommandState } from '../../src/webview/lib/composer-commands.svelte.js'
  import { preferredReasoningEffort } from '../../src/runtime/model-catalog.js'
  import { commandCatalog } from '../fixtures.js'
  type Args = ComponentProps<typeof Composer>
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
</script>

<div class="mx-[-14px] flex min-h-[520px] flex-col justify-end">
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
