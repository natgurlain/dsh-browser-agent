import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { storeManifest } from './src/shared/manifest-key.ts'

/**
 * Build target: `chrome` (default) or `firefox` (set EXT_TARGET=firefox or
 * pass --firefox to scripts/build.mjs). Each target gets its own manifest and
 * output directory so both builds can coexist.
 */
export const browserTarget = process.env.EXT_TARGET === 'firefox' ? 'firefox' : 'chrome'
export const targetManifest = browserTarget === 'firefox' ? 'manifest.firefox.json' : 'manifest.json'

/**
 * Chrome Web Store package (`EXT_STORE=1`, or `--store` on scripts/build.mjs):
 * the store rejects a manifest `key`, so it is stripped and the output goes to
 * its own directory. Unpacked installs keep the key and therefore a fixed ID.
 */
export const storeBuild = process.env.EXT_STORE === '1' && browserTarget === 'chrome'

export const outDir = resolve(import.meta.dirname, browserTarget === 'firefox' ? 'dist-firefox' : storeBuild ? 'dist-store' : 'dist')

/** Copy manifest, locale catalogs, and icons into the target's outDir. */
export const copyManifest = {
  name: 'copy-manifest',
  closeBundle(): void {
    mkdirSync(outDir, { recursive: true })
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, targetManifest), 'utf8')) as Record<string, unknown>
    writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(storeBuild ? storeManifest(manifest) : manifest, null, 2)}\n`)
    cpSync(resolve(import.meta.dirname, '_locales'), resolve(outDir, '_locales'), { recursive: true })
    cpSync(resolve(import.meta.dirname, 'assets'), resolve(outDir, 'assets'), { recursive: true })
  },
}

export const sharedPlugins = [copyManifest]

/** Shared build options for the non-panel targets. */
export function targetBuild(entry: string, format: 'es' | 'iife', entryFileNames: string, emptyOutDir: boolean) {
  return defineConfig({
    define: {
      'import.meta.env.EXT_TARGET': JSON.stringify(browserTarget),
    },
    build: {
      outDir,
      emptyOutDir,
      rollupOptions: {
        input: resolve(import.meta.dirname, entry),
        output: { format, entryFileNames },
      },
    },
    plugins: sharedPlugins,
  })
}
