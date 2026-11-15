/**
 * Entry of the MAIN-world content script (`listener-shim.js`, declared in the
 * manifest with `world: "MAIN"` and `run_at: "document_start"`).
 *
 * @module
 */

import { installListenerShim } from './listener-shim.ts'

installListenerShim(window)
