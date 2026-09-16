import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [paraglideVitePlugin({ project: './project.inlang', outdir: './src/lib/paraglide', emitTsDeclarations: true, strategy: ['globalVariable', 'preferredLanguage', 'baseLocale'] }), tailwindcss(), sveltekit()] });
