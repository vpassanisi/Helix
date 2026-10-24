<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import ModelsSettings from '../../src/webview/components/ModelsSettings.svelte'
  import type { ModelEditorDraft } from '../../src/webview/types.js'
  let { args }: { args: ComponentProps<typeof ModelsSettings> } = $props()
  let drafts = $state<ModelEditorDraft[]>([])
  let status = $state('')
  $effect(() => { drafts = structuredClone($state.snapshot(args.modelDrafts)); status = '' })
</script>

<ModelsSettings {...args} bind:modelDrafts={drafts}
  onAddModel={(id) => {
    args.onAddModel(id)
    const model = args.discoveredModels.find((entry) => entry.id === id)
    if (!model || drafts.some((entry) => entry.id === id)) return
    const { loaded, ...entry } = model
    drafts = [{ ...entry, key: Math.max(0, ...drafts.map((draft) => draft.key)) + 1,
      reasoningEfforts: entry.reasoningEfforts ?? [], reasoningFormat: 'auto', binaryThinkingMode: 'on',
      acceptsImages: false, chatTemplateKwargsText: '{}', chatTemplateArgsText: '{}', systemInstructions: '' }, ...drafts]
    status = 'Model added.'
  }}
  onStatus={(text, tone) => { args.onStatus(text, tone); status = text }}
  onSaveModels={() => { args.onSaveModels(); status = 'Models saved.' }} />
{#if status}<p class="settings-status" role="status">{status}</p>{/if}
