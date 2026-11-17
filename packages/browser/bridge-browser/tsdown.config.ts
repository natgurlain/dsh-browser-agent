import { defineConfig } from 'tsdown'

/**
 * The bridge package ships TWO runtime entries: the plugin (index) and the
 * protocol module — the extension imports
 * `dsh-browser-agent/protocol`, so the protocol bundle is part
 * of the published surface, not an internal module.
 */
export default defineConfig({
  // browser-preset is the `browser` agent preset's row, loaded by URL.
  entry: ['lib/types/index.js', 'lib/types/protocol.js', 'lib/types/browser-preset.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
