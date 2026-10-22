<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import SkillsDrawer from '../../src/webview/components/SkillsDrawer.svelte'
  import { SkillRoutingState } from '../../src/webview/lib/skill-routing.svelte.js'

  let { args }: { args: ComponentProps<typeof SkillsDrawer> } = $props()

  // The drawer writes through a real routing state, the same object App binds in
  // the composer, so toggling a skill proves the class-field binding.
  const routing = new SkillRoutingState(
    () => {},
    () => ({
      enabled: true, sessionId: 'preview', isGenerating: false, hasPendingSubmission: false,
      prompt: '', decisions: undefined, languageId: undefined,
    }),
    () => [],
  )
  $effect(() => {
    routing.applyCatalog({ skills: args.skills, revision: 'preview', complete: true })
    routing.overrides = structuredClone($state.snapshot(args.overrides))
  })
</script>

<SkillsDrawer {...args} overrides={routing.overrides} onoverride={(value) => { args.onoverride(value); routing.overrides = value }} />
