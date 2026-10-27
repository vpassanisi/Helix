<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import GenUiCard from '../src/webview/components/GenUiCard.svelte'
  import Preview from './previews/GenUiPreview.svelte'
  import { genUiAlerts, genUiCodeExample, genUiCodeSnippet, genUiDismissed, genUiFailed, genUiJsonPayload, genUiReleaseNoteForm, genUiTestSuite, genUiWebhookDesign } from './fixtures.js'

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
<Story name="JSON snippet" args={{ view: genUiCodeSnippet, onui: fn() }}>
  Code the reader pastes, in a CodeBlock with its language as a label. The button copies the same string, so the card hands over the text it shows.
</Story>
<Story name="Code example" args={{ view: genUiCodeExample, onui: fn() }}>
  A snippet and the diff that applies it. There is no highlighting: the block is monospace, and long lines scroll sideways.
</Story>
<Story name="JSON payload" args={{ view: genUiJsonPayload, onui: fn() }}>
  The JSON the model quotes back, beside a table that reads the same keys at a glance.
</Story>
<Story name="Wide code lines" args={{ view: genUiWebhookDesign, onui: fn() }}>
  A card a real call produced. Seven of its fourteen code lines are wider than a 280px sidebar, so the block scrolls sideways. CodeBlock paints no syntax colors: the dark surface next to the accent border is what reads as a highlight.
</Story>
<Story name="Rejected spec" args={{ view: genUiFailed, onui: fn() }}>
  The catalog refused the spec, so the model was told why. The reason stays visible in the transcript.
</Story>
<Story name="Dismissed" args={{ view: genUiDismissed, onui: fn() }} />
