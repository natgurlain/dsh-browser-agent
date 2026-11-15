import { cpSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { outDir, sharedPlugins } from './vite.shared.ts'

/**
 * `panel/theme-boot.js` is a classic, render-blocking script (it sets the theme
 * before first paint), so Vite does not bundle it: ship it next to the page.
 */
const copyThemeBoot = {
  name: 'copy-theme-boot',
  closeBundle(): void {
    mkdirSync(resolve(outDir, 'panel'), { recursive: true })
    cpSync(resolve(import.meta.dirname, 'panel/theme-boot.js'), resolve(outDir, 'panel/theme-boot.js'))
  },
}

/** Side panel: React application (html entry). */
export default defineConfig({
  plugins: [react(), ...sharedPlugins, copyThemeBoot],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'panel/index.html'),
      output: {
        entryFileNames: 'panel/assets/[name].js',
        chunkFileNames: 'panel/assets/[name]-[hash].js',
        assetFileNames: 'panel/assets/[name][extname]',
      },
    },
  },
})

export { outDir }
