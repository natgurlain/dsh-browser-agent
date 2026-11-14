import assert from 'node:assert/strict'
import test from 'node:test'
import { rewriteDshVersions } from '../dsh-matrix.mjs'

test('rewriteDshVersions only touches @deepseek-ai/dsh* packages', () => {
  const deps = {
    '@deepseek-ai/dsh': '0.2.2-rc.2',
    '@deepseek-ai/dsh-fs': '0.2.2-rc.2',
    '@deepseek-ai/cordis': '~4.1.0',
    '@deepseek-ai/dshx': '1.0.0',
    ws: '^8.21.0',
  }
  assert.deepEqual(rewriteDshVersions(deps, '0.2.2-rc.3'), ['@deepseek-ai/dsh', '@deepseek-ai/dsh-fs'])
  assert.deepEqual(deps, {
    '@deepseek-ai/dsh': '0.2.2-rc.3',
    '@deepseek-ai/dsh-fs': '0.2.2-rc.3',
    '@deepseek-ai/cordis': '~4.1.0',
    '@deepseek-ai/dshx': '1.0.0',
    ws: '^8.21.0',
  })
  assert.deepEqual(rewriteDshVersions(undefined, '1.0.0'), [])
})
