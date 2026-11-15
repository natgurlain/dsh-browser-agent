/**
 * Build extension targets sequentially into dist/ (or dist-firefox/
 * with --firefox, or dist-store/ with --store for a Chrome Web Store upload,
 * whose manifest omits the `key` that pins unpacked installs to one ID):
 * background (es|iife) → content (iife) → page-world listener shim (iife) →
 * panel (React) → offscreen (iife).
 * The first target cleans the output; the later ones append.
 * Pass --watch for dev rebuilds.
 */

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const watch = process.argv.includes('--watch')

// --firefox switches the manifest and background bundle for the Firefox build.
if (process.argv.includes('--firefox')) {
  process.env.EXT_TARGET = 'firefox'
}
// --store strips the manifest `key` (the Web Store rejects it) into dist-store/.
if (process.argv.includes('--store')) {
  process.env.EXT_STORE = '1'
}

const configs = [
  'vite.background.config.ts',
  'vite.content.config.ts',
  'vite.shim.config.ts',
  'vite.panel.config.ts',
  'vite.offscreen.config.ts',
]

if (watch) {
  // Start the watcher of every build target in parallel.
  const children = configs.map((config) => spawn('vite', ['build', '--config', config, '--watch'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }))
  for (const child of children) {
    child.on('exit', (code) => { if (code !== 0) process.exit(code ?? 1) })
  }
} else {
  for (const config of configs) {
    const result = spawnSync('vite', ['build', '--config', config], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
