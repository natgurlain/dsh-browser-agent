import { outDir, targetBuild } from './vite.shared.ts'

/**
 * Page-world listener shim: a classic script the manifest injects with
 * `world: "MAIN"` at `document_start` (see src/main-world/listener-shim.ts).
 */
export default targetBuild('src/main-world/index.ts', 'iife', 'listener-shim.js', false)

export { outDir }
