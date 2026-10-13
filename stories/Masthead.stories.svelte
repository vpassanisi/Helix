<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import Masthead from '../src/webview/components/Masthead.svelte'
  const { Story } = defineMeta({ title: 'Chat/Masthead', component: Masthead, args: { onNewSession: fn(), onOpenSettings: fn() } })
</script>

<Story name="Default" />
