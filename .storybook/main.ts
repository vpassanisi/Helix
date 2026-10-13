import type { StorybookConfig } from '@storybook/svelte-vite'

const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.svelte'],
  addons: ['@storybook/addon-svelte-csf'],
  framework: {
    name: '@storybook/svelte-vite',
    options: { builder: { viteConfigPath: '.storybook/vite.config.ts' } },
  },
  core: { disableTelemetry: true },
}

export default config
