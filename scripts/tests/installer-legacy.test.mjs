// The installers and the uninstaller must agree on the bridge's earlier package
// names: installing over an upstream install has to drop the old registration,
// and uninstall has to find every name an installer could have left.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const CURRENT = 'dsh-browser-agent'

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

test('uninstall finds linked checkouts by the root package name, so that name is pinned', () => {
  const name = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).name
  assert.equal(name, 'dsh-browser')
  assert.match(read('uninstall.mjs'), /\?\.name === 'dsh-browser' \? \[root\] : \[\]/u)
})

test('updates keep the installed bridge-token copy instead of deleting and re-creating it', () => {
  assert.match(read('install.sh'), /rsync -a --delete-after --exclude '\/bridge-token' "\$EXT\/dist\/"/u)
  assert.match(read('install.ps1'), /-Destination \$DistDir -ExcludeName @\('bridge-token'\)/u)
})

test('both installers carry settings saved under the previous name over, after the old registration is gone', () => {
  // install.sh runs it per profile (covered end to end in installer-upgrade.test.mjs);
  // install.ps1 cannot run here, so its order is pinned: after the bundle list no longer
  // selects any legacy name, so that the shared home patch can move too.
  const sh = read('install.sh')
  assert.ok(sh.indexOf('migrate_bridge_settings web') > sh.indexOf('pnpm exec dsh plugin --profile web remove'))
  assert.ok(sh.indexOf('migrate_bridge_settings web') < sh.indexOf('pnpm exec dsh plugin --profile web add'))
  assert.ok(sh.indexOf('migrate_bridge_settings desktop') > sh.indexOf('desktop_cli plugin --profile desktop remove'))
  assert.ok(sh.indexOf('migrate_bridge_settings desktop') < sh.indexOf('desktop_cli plugin --profile desktop add'))
  const ps1 = read('install.ps1')
  const call = ps1.indexOf("& node (Join-Path $Root 'scripts\\migrate-bridge-name.mjs') --lang $ReleaseLang $DshHomeDir 'web'")
  assert.ok(call > 0, 'install.ps1 runs migrate-bridge-name.mjs for the web profile')
  assert.ok(call > ps1.indexOf('$ProfileManifest.dsh.profile.bundles = $Bundles'))
  assert.match(read('migrate-bridge-name.mjs'), /export const OLD_NAME = '@natgurlain\/dsh-bridge-browser'/u)
  assert.ok(uninstallNames().includes('@natgurlain/dsh-bridge-browser'), 'uninstall removes the previous name too')
})
