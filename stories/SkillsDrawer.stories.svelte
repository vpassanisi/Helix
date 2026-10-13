<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import { fn } from 'storybook/test'
  import type { ComponentProps } from 'svelte'
  import SkillsDrawer from '../src/webview/components/SkillsDrawer.svelte'
  import Preview from './previews/SkillsPreview.svelte'
  import { skills, suggestions } from './fixtures.js'

  const { Story } = defineMeta({
    title: 'Context/SkillsDrawer', component: SkillsDrawer, render: template,
    args: { skills, suggestions, overrides: { include: [], exclude: [] }, disabled: false, error: '', onoverride: fn() },
  })
</script>

{#snippet template(args: ComponentProps<typeof SkillsDrawer>)}
  <Preview {args} />
{/snippet}

<Story name="Suggestions" />
<Story name="Checking" args={{ suggestions: { ...suggestions, status: 'checking' } }} />
<Story name="Unavailable" args={{ error: 'Skill suggestions are unavailable.' }} />
<Story name="Empty" args={{ skills: [], suggestions: { ...suggestions, selected: [] } }} />
