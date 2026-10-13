<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf'
  import AboutSettings from '../src/webview/components/AboutSettings.svelte'
  import manifest from '../package.json'
  const { Story } = defineMeta({ title: 'Settings/AboutSettings', component: AboutSettings,
    args: { info: { name: manifest.displayName, version: manifest.version, vscodeVersion: '1.100.0', license: manifest.license } },
  })
</script>

<Story name="Extension information" />
<Story name="Unavailable" args={{ info: undefined }} />
