<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import SkillsDrawer from '../../src/webview/components/SkillsDrawer.svelte'
  import type { SkillOverrides } from '../../src/shared/skills.js'
  let { args }: { args: ComponentProps<typeof SkillsDrawer> } = $props()
  let overrides = $state<SkillOverrides>({ include: [], exclude: [] })
  $effect(() => { overrides = structuredClone($state.snapshot(args.overrides)) })
</script>

<SkillsDrawer {...args} {overrides} onoverride={(value) => { args.onoverride(value); overrides = value }} />
