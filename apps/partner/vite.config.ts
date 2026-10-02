import { svelte } from '@sveltejs/vite-plugin-svelte';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vite';
export default defineConfig({ publicDir: 'static', build: { outDir: 'build' }, plugins: [paraglideVitePlugin({ project: './project.inlang', outdir: './src/lib/paraglide', emitTsDeclarations: true, strategy: ['globalVariable', 'preferredLanguage', 'baseLocale'] }), svelte()] });
