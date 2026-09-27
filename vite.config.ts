import { defineConfig, type Plugin } from 'vite';
import electron from 'vite-plugin-electron/simple';
import tailwindcss from '@tailwindcss/vite';

const ignoreMarkdownHmr: Plugin = {
    name: 'quickview-ignore-markdown-hmr',
    enforce: 'pre',
    hotUpdate({ file }) {
        if (file.toLowerCase().endsWith('.md')) return [];
    },
};

export default defineConfig({
    server: {
        watch: { ignored: [/\.md$/i] },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        rollupOptions: {
            input: 'src/ui/index.html',
        },
    },
    plugins: [
        ignoreMarkdownHmr,
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
