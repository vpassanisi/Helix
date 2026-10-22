<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import type { ComponentProps } from 'svelte'
  import Preview from './previews/SettingsViewPreview.svelte'

  const args: ComponentProps<typeof Preview> = { page: 'about', status: '', tone: '' }

  const { Story } = defineMeta({ title: 'Settings/SettingsView', component: Preview, args })
</script>

<Story name="About page" />
<Story name="Connection drafts" args={{ page: 'connection', status: '', tone: '' }} />
<Story name="Model catalog drafts" args={{ page: 'models', status: '', tone: '' }} />
<Story name="Models saving" args={{ page: 'models', status: 'Saving models…', tone: 'warning' }} />
<Story name="Saving" args={{ page: 'connection', status: 'Applying settings…', tone: 'warning' }} />
<Story name="Saved" args={{ page: 'about', status: 'Saved.', tone: 'success' }} />
<Story name="Failed" args={{ page: 'connection', status: 'Runtime failed to restart.', tone: 'warning' }} />
