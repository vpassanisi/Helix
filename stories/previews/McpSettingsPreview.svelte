<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import McpSettings from '../../src/webview/components/McpSettings.svelte'
  import type { McpServerDraft } from '../../src/webview/types.js'
  let { args }: { args: ComponentProps<typeof McpSettings> } = $props()
  let servers = $state<McpServerDraft[]>([])
  $effect(() => { servers = structuredClone($state.snapshot(args.mcpServers)) })
</script>

<McpSettings {...args} bind:mcpServers={servers} />
