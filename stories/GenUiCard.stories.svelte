<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import GenUiCard from '../src/webview/components/GenUiCard.svelte'
  import Preview from './previews/GenUiPreview.svelte'
  import { genUiAlerts, genUiDismissed, genUiFailed, genUiReleaseNoteForm, genUiTestSuite } from './fixtures.js'

  const { Story } = defineMeta({
    title: 'Chat/GenUiCard', component: GenUiCard, render: template,
    args: { view: genUiTestSuite, onui: fn() },
  })
</script>

{#snippet template(args: ComponentProps<typeof GenUiCard>)}
  <Preview {args} />
{/snippet}

<Story name="Dashboard" />
<Story name="Deploy check" args={{ view: genUiAlerts, onui: fn() }} />
<Story name="Form" args={{ view: genUiReleaseNoteForm, onui: fn() }}>
  The card keeps its own state. Typing in the field, then pressing the button, sends the typed text back to Helix.
</Story>
<Story name="Rejected spec" args={{ view: genUiFailed, onui: fn() }}>
  The catalog refused the spec, so the model was told why. The reason stays visible in the transcript.
</Story>
<Story name="Dismissed" args={{ view: genUiDismissed, onui: fn() }} />
