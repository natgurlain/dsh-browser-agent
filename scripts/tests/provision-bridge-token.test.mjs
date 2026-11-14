import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const script = join(root, 'scripts', 'provision-bridge-token.mjs')
const posix = process.platform !== 'win32'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-provision-'))
  const home = join(base, 'home')
  const extension = join(home, 'browser-extension')
  mkdirSync(extension, { recursive: true })
  return { home, extension }
}

function provision(home, extension) {
  const result = spawnSync(process.execPath, [script, home, extension], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result
}

const mode = path => statSync(path).mode & 0o777

test('creates the bridge token the plugin would create, and copies it into the extension', () => {
  const { home, extension } = fixture()
  provision(home, extension)
  const token = readFileSync(join(home, 'ext-bridge-token'), 'utf8')
  assert.match(token, /^[0-9a-f]{64}\n$/)
  assert.equal(readFileSync(join(extension, 'bridge-token'), 'utf8'), token)
  if (posix) {
    assert.equal(mode(join(home, 'ext-bridge-token')), 0o600)
    assert.equal(mode(join(extension, 'bridge-token')), 0o600)
  }
})

test('reuses an existing token instead of rotating it', () => {
  const { home, extension } = fixture()
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'ext-bridge-token'), 'existing-token\n', { mode: 0o600 })
  provision(home, extension)
  assert.equal(readFileSync(join(home, 'ext-bridge-token'), 'utf8'), 'existing-token\n')
  assert.equal(readFileSync(join(extension, 'bridge-token'), 'utf8'), 'existing-token\n')
})

test('tightens a copy left with looser permissions', { skip: !posix }, () => {
  const { home, extension } = fixture()
  writeFileSync(join(extension, 'bridge-token'), 'stale\n', { mode: 0o644 })
  provision(home, extension)
  assert.equal(mode(join(extension, 'bridge-token')), 0o600)
  assert.notEqual(readFileSync(join(extension, 'bridge-token'), 'utf8'), 'stale\n')
})

test('refuses to run without both directories', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Usage/)
})
