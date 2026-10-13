<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import BrowserAttachments from '../src/webview/components/BrowserAttachments.svelte'
  import Preview from './previews/BrowserAttachmentsPreview.svelte'
  import { attachments } from './fixtures.js'

  const { Story } = defineMeta({
    title: 'Context/BrowserAttachments', component: BrowserAttachments, render: template,
    args: { attachments, disabled: false, onremove: fn() },
  })
</script>

{#snippet template(args: ComponentProps<typeof BrowserAttachments>)}
  <Preview {args} />
{/snippet}

<Story name="Attached" />
<Story name="Disabled" args={{ disabled: true }} />
<Story name="Long label" args={{ attachments: [{ ...attachments[0], label: 'A long label for the selected element in the active browser tab' }] }} />
