import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      tailwindcss(),
    ]
  },
  preload: {
    plugins: [
      externalizeDepsPlugin(),
      tailwindcss(),
    ]
  },
  renderer: {
    plugins: [svelte()]
  }
})
