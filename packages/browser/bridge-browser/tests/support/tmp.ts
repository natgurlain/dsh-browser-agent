/** Temporary directories that are removed after each test of the calling spec. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

/**
 * Register an `afterEach` cleanup and return a factory of fresh directories.
 * Call once at the top level of a spec.
 * @param prefix - directory name prefix under the OS temp dir.
 */
export function tempDirs(prefix: string): () => string {
  const made: string[] = []
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  return () => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    made.push(dir)
    return dir
  }
}
