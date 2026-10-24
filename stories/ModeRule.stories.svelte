<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import ModeRule from '../src/webview/components/ModeRule.svelte'
  const { Story } = defineMeta({ title: 'Chat/ModeRule', component: ModeRule, args: { label: 'Plan Mode' } })
</script>

<Story name="Plan mode on" />
<Story name="Plan mode off" args={{ label: 'Plan Mode Off' }} />
