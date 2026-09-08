import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: `${projectRoot}/src/webview`,
  base: './',
  plugins: [svelte({ configFile: `${projectRoot}/svelte.config.js` }), tailwindcss()],
  build: {
    outDir: `${projectRoot}/out/webview`,
    emptyOutDir: true,
    assetsDir: 'assets',
  },
})
