import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [svelte({ configFile: fileURLToPath(new URL('../svelte.config.js', import.meta.url)) }), tailwindcss()],
})
