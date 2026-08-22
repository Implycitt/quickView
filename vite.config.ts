import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    electron({
      main: {
        entry: 'src/main.ts', 
      },
      preload: {
        input: 'src/preload.cts', 
      },
      renderer: {},
    }),
  ],
});