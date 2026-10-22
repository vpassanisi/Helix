<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import type { ComponentProps } from 'svelte'
  import Preview from './previews/AppPreview.svelte'
  import { hostTurn } from './fixtures.js'

  const args: ComponentProps<typeof Preview> = { messages: [] }

  const { Story } = defineMeta({ title: 'App/Shell', component: Preview, args })
</script>

<Story name="Idle" />
<Story name="Streamed turn" args={{ messages: hostTurn }} />
