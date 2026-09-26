import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: ['dist/**', 'dist-electron/**', 'node_modules/**', 'release/**'],
    },
    {
        files: ['**/*.{js,cjs,mjs}'],
        ...js.configs.recommended,
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
    {
        files: ['**/*.{ts,cts,mts}'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: [
            'src/pdfjs.ts',
            'src/preload.cts',
            'src/rendering/fileHandler.ts',
            'src/rendering/pdfRenderer.ts',
            'src/rendering/pdfSearch.ts',
            'src/types/types.d.ts',
        ],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
);
