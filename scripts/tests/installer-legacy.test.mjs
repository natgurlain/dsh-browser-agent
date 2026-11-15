// The installers and the uninstaller must agree on the bridge's earlier package
// names: installing over an upstream install has to drop the old registration,
// and uninstall has to find every name an installer could have left.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const CURRENT = '@natgurlain/dsh-bridge-browser'

function uninstallNames() {
  const match = /const BRIDGES = \[([^\]]*)\]/u.exec(read('uninstall.mjs'))
  assert.ok(match, 'uninstall.mjs declares BRIDGES')
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1])
}

test('install.sh removes every legacy bridge name uninstall knows', () => {
  const match = /^LEGACY_PLUGINS="([^"]*)"$/mu.exec(read('install.sh'))
  assert.ok(match, 'install.sh declares LEGACY_PLUGINS')
  const legacy = match[1].split(/\s+/u).filter(Boolean)
  assert.deepEqual(legacy.toSorted(), uninstallNames().filter((name) => name !== CURRENT).toSorted())
  assert.match(read('install.sh'), /for legacy_plugin in \$LEGACY_PLUGINS; do/u)
})

test('install.ps1 removes every legacy bridge name uninstall knows, including from bundles', () => {
  const source = read('install.ps1')
  const match = /^\$LegacyPlugins = @\(([^)]*)\)$/mu.exec(source)
  assert.ok(match, 'install.ps1 declares $LegacyPlugins')
  const legacy = [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1])
  assert.deepEqual(legacy.toSorted(), uninstallNames().filter((name) => name !== CURRENT).toSorted())
  assert.match(source, /foreach \(\$LegacyPlugin in \$LegacyPlugins\)/u)
  assert.match(source, /Where-Object \{ \$LegacyPlugins -notcontains \$_ \}/u)
})

test('updates keep the installed bridge-token copy instead of deleting and re-creating it', () => {
  assert.match(read('install.sh'), /rsync -a --delete-after --exclude '\/bridge-token' "\$EXT\/dist\/"/u)
  assert.match(read('install.ps1'), /-Destination \$DistDir -ExcludeName @\('bridge-token'\)/u)
})
