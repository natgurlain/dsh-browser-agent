#!/usr/bin/env node
// pnpm test:release-dry-run: the opt-in end-to-end test in release-install.test.mjs.
// It packages the real installer assets, serves them locally, and runs the installer
// (download, verify, pnpm install, build, register) into a throwaway DSH home.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const result = spawnSync(process.execPath, [
  '--test', '--test-name-pattern', '^dry run:',
  fileURLToPath(new URL('./release-install.test.mjs', import.meta.url)),
], { stdio: 'inherit', env: { ...process.env, DSH_RELEASE_E2E: '1' } })
process.exit(result.status ?? 1)
