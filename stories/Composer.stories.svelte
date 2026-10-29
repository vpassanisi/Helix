<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import Composer from '../src/webview/components/Composer.svelte'
  import Preview from './previews/ComposerPreview.svelte'
  import { models, modelOptionLabel, changes, attachments, skills, suggestions, historyMessages } from './fixtures.js'
  import type { ChatMessage } from '../src/webview/types.js'
  type Args = ComponentProps<typeof Composer> & { messages?: ChatMessage[] }
  const { Story } = defineMeta({
    title: 'Chat/Composer', component: Composer, render: template,
    args: {
      prompt: 'Review the changes panel.', isGenerating: false, waitingForAnswer: false, submissionPending: false,
      selectionAttached: true, codeChanges: [], changesOpen: false,
      models, model: models[0].id, reasoningEffort: 'high', modelChanging: false,
      contextUsedTokens: 24000, contextWindowTokens: 128000,
      skillPickerEnabled: false, skills, skillSuggestions: suggestions, skillOverrides: { include: [], exclude: [] }, skillError: '',
      modelOptionLabel, onSubmit: fn(), onModelSelect: fn(), onReasoningEffortSelect: fn(), onRemoveBrowserAttachment: fn(), onToggleBrowserPicker: fn(),
    },
  })
</script>

{#snippet template(args: Args)}
  <Preview {args} />
{/snippet}

<Story name="Ready" />
<Story name="With history" args={{ messages: historyMessages, prompt: '' }} />
<Story name="Empty" args={{ prompt: '' }} />
<Story name="Generating" args={{ isGenerating: true, prompt: '' }} />
<Story name="Waiting for answer" args={{ isGenerating: true, waitingForAnswer: true }} />
<Story name="Submitting" args={{ isGenerating: true, submissionPending: true }} />
<Story name="Editor context" args={{ selection: { fileLabel: 'src/webview/App.svelte', languageId: 'svelte', ranges: [{ startLine: 10, startColumn: 1, endLine: 25, endColumn: 1 }] } }} />
<Story name="Browser attachments" args={{ browserContext: { sessionId: 'preview', available: true, hasOpenBrowser: true, picking: false, attachments } }} />
<Story name="Changes while generating" args={{ isGenerating: true, codeChanges: changes, changesOpen: true }} />
<Story name="Skills enabled" args={{ skillPickerEnabled: true }} />
<Story name="Slash menu" args={{ prompt: '/' }} />
<Story name="Slash filter" args={{ prompt: '/comp' }} />
<Story name="Command ready" args={{ prompt: '/compact' }} />
<Story name="Command with args" args={{ prompt: '/goal pause' }} />
<Story name="Unknown command" args={{ prompt: '/xyzzy' }} />
<Story name="Full context" args={{ contextUsedTokens: 128000 }} />
<Story name="Unknown context" args={{ contextUsedTokens: undefined, contextWindowTokens: undefined }} />
