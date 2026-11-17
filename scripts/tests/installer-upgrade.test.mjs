// Updating across the package rename @natgurlain/dsh-bridge-browser -> dsh-browser-agent
// (v0.3.1): exactly one bridge stays registered, and settings saved under the old name keep
// applying. The end-to-end cases run the real install.sh with the real DSH plugin commands
// against a throwaway DSH home; only the builds and the browser launch are stubbed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { migrate, NEW_NAME, OLD_NAME, rewritePatchText } from '../migrate-bridge-name.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const anchor = realpathSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
const require = createRequire(anchor)
const { composeEntries, initProfile, loadOptionalPatches, loadOverlayPatches } =
  await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const { runPluginCommand } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
const dshBin = join(dirname(anchor), 'lib', 'bin.js')
const bundlePatch = join(root, 'packages', 'browser', 'bridge-browser', 'cordis.patch.yml')
const UPSTREAM = '@deepseek-ai/dsh-bridge-browser'
const BRIDGE_NAMES = [NEW_NAME, OLD_NAME, UPSTREAM, '@yuxianglin/dsh-bridge-browser']
const noShell = process.platform === 'win32' ? 'install.sh is not used on Windows' : false

// What DSH's plugin settings page writes for the bridge (dsh-config-editor), plus a toggle row.
const SAVED_SETTINGS = `# Saved from the plugin settings page.
- id: bridge-browser
  name: "${OLD_NAME}"
  config:
    autoReview: false
    toolTimeoutMs: 45000
- id: bridge-browser
  disabled: false
`

/** The bridge entry the running DSH composes from the bundle patch and the given patch files. */
function composedBridge(...patchFiles) {
  const warnings = []
  const layers = [loadOverlayPatches('dsh', bundlePatch), ...patchFiles.map(file => loadOptionalPatches('dsh', file) ?? [])]
  const entry = composeEntries(layers, message => warnings.push(message)).find(row => row.id === 'bridge-browser')
  return { entry, warnings }
}

function temporary(t, prefix) {
  const base = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return base
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('rewritePatchText renames only name: values of the previous package, in every YAML form', () => {
  const source = [
    '# keep this comment',
    '- id: bridge-browser',
    `  name: "${OLD_NAME}"   # trailing comment stays`,
    '  config:',
    '    token: !!js process.env.DSH_EXT_TOKEN',
    '    note: "@natgurlain/dsh-bridge-browser is not a name: value"',
    `- { id: bridge-browser, name: '${OLD_NAME}', disabled: true }`,
    `- id: other\n  name: '${UPSTREAM}'`,
    `- id: x\n  name: "${OLD_NAME}-fork"`,
    `- id: y\n  rename: "${OLD_NAME}"`,
    '',
  ].join('\n')
  const { text, count } = rewritePatchText(source)
  assert.equal(count, 2)
  assert.equal(text, source
    .replace(`  name: "${OLD_NAME}"   #`, `  name: "${NEW_NAME}"   #`)
    .replace(`name: '${OLD_NAME}', disabled`, `name: '${NEW_NAME}', disabled`))
  assert.deepEqual(rewritePatchText(text), { text, count: 0 }, 'a second run changes nothing')
  // CRLF files keep their line endings.
  assert.equal(rewritePatchText(`- id: bridge-browser\r\n  name: '${OLD_NAME}'\r\n`).text, `- id: bridge-browser\r\n  name: '${NEW_NAME}'\r\n`)
})

test('real DSH composition: a row saved under the old name is skipped until it is migrated', (t) => {
  const base = temporary(t, 'dsh-bridge-rename-')
  const patch = join(base, 'cordis.patch.yml')
  writeFileSync(patch, SAVED_SETTINGS, { mode: 0o600 })

  const before = composedBridge(patch)
  assert.equal(before.entry.name, NEW_NAME)
  assert.equal(before.entry.config.autoReview, undefined, 'the old-name row does not apply to the renamed package')
  assert.match(before.warnings.join('\n'), /name mismatch for "bridge-browser"/u)

  const result = migrate(join(base, 'no-home'), [])
  assert.deepEqual(result, { rewritten: [], homeKeptFor: [] }, 'a missing home is not an error')
  const home = join(base, 'home')
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  cpSync(patch, join(home, 'profiles', 'web', 'cordis.patch.yml'))
  chmodSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 0o600)
  assert.deepEqual(migrate(home, ['web']).rewritten, [{ path: join(home, 'profiles', 'web', 'cordis.patch.yml'), count: 1 }])
  const migrated = join(home, 'profiles', 'web', 'cordis.patch.yml')
  assert.equal(statSync(migrated).mode & 0o777, 0o600, 'the file mode is kept')
  assert.match(readFileSync(migrated, 'utf8'), /^# Saved from the plugin settings page\.$/mu, 'comments are kept')
  const after = composedBridge(migrated)
  assert.equal(after.entry.config.autoReview, false)
  assert.equal(after.entry.config.toolTimeoutMs, 45000)
  assert.deepEqual(after.warnings, [])
})

test('the shared home patch moves only once no profile still uses the old package', (t) => {
  const home = join(temporary(t, 'dsh-bridge-rename-'), 'home')
  const profile = (name, manifest) => {
    mkdirSync(join(home, 'profiles', name), { recursive: true })
    writeFileSync(join(home, 'profiles', name, 'package.json'), JSON.stringify(manifest))
  }
  profile('web', { dependencies: { [NEW_NAME]: 'link:/x' }, dsh: { profile: { bundles: [NEW_NAME] } } })
  profile('desktop', { dependencies: {}, dsh: { profile: { bundles: [OLD_NAME] } } })
  const homePatch = join(home, 'cordis.patch.yml')
  const target = join(home, 'patches', 'home.yml')
  mkdirSync(dirname(target))
  writeFileSync(target, SAVED_SETTINGS)
  symlinkSync(target, homePatch)

  const kept = migrate(home, ['web'])
  assert.deepEqual(kept, { rewritten: [], homeKeptFor: ['desktop'] }, 'a selected bundle counts as still in use')
  assert.equal(readFileSync(homePatch, 'utf8'), SAVED_SETTINGS)

  profile('desktop', { dependencies: { [NEW_NAME]: 'link:/x' }, dsh: { profile: { bundles: [NEW_NAME] } } })
  assert.deepEqual(migrate(home, ['desktop']).rewritten, [{ path: homePatch, count: 1 }])
  assert.equal(lstatSync(homePatch).isSymbolicLink(), true, 'a linked home patch stays a link')
  assert.equal(readlinkSync(homePatch), target)
  assert.equal(composedBridge(homePatch).entry.config.autoReview, false)
  assert.throws(() => migrate(home, ['../web']), /invalid profile name/u)
})

/** A DSH profile with the given bridge names registered through DSH's own plugin command. */
async function seedProfile(home, profileName, bridge, names) {
  const dir = join(home, 'profiles', profileName)
  initProfile(dir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  for (const name of names) {
    const result = await runPluginCommand({ profile: profileName, dir, installAnchor: anchor, cwd: dir },
      ['add', '-w', `${name}@link:${bridge}`], { execution: 'service', outputBytes: 16384, env: { DSH_HOME: home } })
    assert.equal(result.exitCode, 0, result.output)
  }
  writeFileSync(join(dir, 'cordis.patch.yml'), SAVED_SETTINGS, { mode: 0o600 })
  return dir
}

/** The bridge names a profile depends on or selects. */
function bridgesOf(profileDir) {
  const manifest = readJson(join(profileDir, 'package.json'))
  return {
    dependencies: BRIDGE_NAMES.filter(name => Object.hasOwn(manifest.dependencies ?? {}, name)),
    bundles: BRIDGE_NAMES.filter(name => manifest.dsh?.profile?.bundles?.includes(name)),
  }
}

/**
 * A checkout holding the real scripts, a copy of the built bridge package and the built
 * extension, with `pnpm exec dsh` going to the real DSH CLI and every other pnpm call (the
 * install and the builds) recorded and skipped. `desktop` adds a stand-in for the desktop app
 * whose bundled CLI is the same real DSH CLI.
 */
function checkout(t, { desktop = false } = {}) {
  const base = temporary(t, 'dsh-bridge-upgrade-')
  const dshHome = join(base, 'home', '.dsh')
  const source = join(base, 'checkout')
  mkdirSync(dshHome, { recursive: true })
  for (const name of ['package.json', 'pnpm-lock.yaml']) cpSync(join(root, name), join(source, name))
  cpSync(join(root, 'scripts'), join(source, 'scripts'), { recursive: true })
  const bridge = join(source, 'packages', 'browser', 'bridge-browser')
  cpSync(join(root, 'packages', 'browser', 'bridge-browser'), bridge, {
    recursive: true, filter: path => !path.split(/[\\/]/u).includes('node_modules'),
  })
  symlinkSync(join(root, 'node_modules'), join(source, 'node_modules'), 'junction')
  const extension = join(source, 'extensions', 'dsh-browser')
  mkdirSync(extension, { recursive: true })
  cpSync(join(root, 'extensions', 'dsh-browser', 'package.json'), join(extension, 'package.json'))
  cpSync(join(root, 'extensions', 'dsh-browser', 'dist'), join(extension, 'dist'), { recursive: true })

  const ran = join(base, 'ran')
  const bin = join(base, 'bin')
  mkdirSync(bin)
  const realDsh = `PATH=${JSON.stringify(process.env.PATH)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(dshBin)} "$@"`
  writeFileSync(join(bin, 'pnpm'), [
    '#!/bin/bash',
    '[ "$1" = --version ] && { echo 11.7.0; exit 0; }',
    `if [ "$1" = exec ] && [ "$2" = dsh ]; then shift 2; printf 'dsh %s\\n' "$*" >>"$STUB_RAN"; ${realDsh}; fi`,
    'printf \'pnpm %s\\n\' "$*" >>"$STUB_RAN"',
    '',
  ].join('\n'))
  chmodSync(join(bin, 'pnpm'), 0o755)
  // HOME stays the caller's: the profiles were seeded with its pnpm store, and pnpm refuses
  // to remove a package linked from another store.
  const env = {
    ...process.env, DSH_HOME: dshHome, TMPDIR: join(base, 'tmp'), STUB_RAN: ran,
    PATH: `${bin}${delimiter}${process.env.PATH}`, DSH_BROWSER_NO_LAUNCH: '1', DSH_BROWSER_LANG: 'en', DSH_DESKTOP_APP: 'none',
  }
  for (const name of Object.keys(env)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|DSH_BROWSER_(VERSION|UNVERIFIED_BRANCH)|DSH_INSTALL_BROWSER)$/u.test(name)) delete env[name]
  }
  mkdirSync(env.TMPDIR)
  if (desktop) {
    const app = join(base, 'Applications', 'DeepSeek Harness.app')
    const runtime = join(app, 'Contents', 'Resources', 'runtime')
    mkdirSync(join(runtime, 'cli', 'bin'), { recursive: true })
    writeFileSync(join(runtime, 'versions.json'), JSON.stringify({ schemaVersion: 1, node: '24.21.0', pnpm: '11.28.5' }))
    // The npm CLI refuses the `desktop` profile (only the app's bundled CLI may change it), so
    // the stand-in runs DSH's own plugin operations, the ones `dsh plugin` runs, on that profile.
    const cli = join(runtime, 'cli', 'bin', 'cli.mjs')
    writeFileSync(cli, `import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [command, flag, profile, ...args] = process.argv.slice(2)
if (command !== 'plugin' || flag !== '--profile' || profile !== 'desktop') { console.error('unexpected call'); process.exit(9) }
const { runPluginCommand } = await import(pathToFileURL(${JSON.stringify(require.resolve('@deepseek-ai/dsh-plugin-manager/operations'))}).href)
const dir = join(process.env.DSH_HOME, 'profiles', 'desktop')
const result = await runPluginCommand({ profile, dir, installAnchor: ${JSON.stringify(anchor)}, cwd: dir }, args,
  { execution: 'service', outputBytes: 16384, env: { DSH_HOME: process.env.DSH_HOME } })
if (result.exitCode !== 0) console.error(result.output)
process.exit(result.exitCode)
`)
    writeFileSync(join(runtime, 'cli', 'bin', 'dsh'), [
      '#!/bin/sh',
      'printf \'desktop-cli %s\\n\' "$*" >>"$STUB_RAN"',
      `PATH=${JSON.stringify(process.env.PATH)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"`,
      '',
    ].join('\n'))
    chmodSync(join(runtime, 'cli', 'bin', 'dsh'), 0o755)
    env.DSH_DESKTOP_APP = app
  }
  const install = () => {
    const result = spawnSync('bash', [join(source, 'scripts', 'install.sh')], { env, cwd: base, encoding: 'utf8', timeout: 600_000 })
    if (result.error) throw result.error
    writeFileSync(join(base, 'install.log'), result.stdout + result.stderr)
    return result
  }
  const calls = () => existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n') : []
  return { base, dshHome, bridge, install, calls }
}

test('install over a v0.3.0 registration: one bridge, the new name, settings kept, in web and the desktop app', {
  skip: noShell, timeout: 600_000,
}, async (t) => {
  const box = checkout(t, { desktop: true })
  const web = await seedProfile(box.dshHome, 'web', box.bridge, [OLD_NAME])
  const desktop = await seedProfile(box.dshHome, 'desktop', box.bridge, [OLD_NAME, UPSTREAM])
  writeFileSync(join(box.dshHome, 'cordis.patch.yml'), SAVED_SETTINGS)
  assert.deepEqual(bridgesOf(web), { dependencies: [OLD_NAME], bundles: [OLD_NAME] })

  const result = box.install()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const link = `${NEW_NAME}@link:${box.bridge}`
  assert.deepEqual(box.calls().filter(line => /^(dsh|desktop-cli) /u.test(line)), [
    `dsh plugin --profile web remove ${OLD_NAME}`,
    `dsh plugin --profile web add -w ${link}`,
    `desktop-cli plugin --profile desktop remove ${OLD_NAME}`,
    `desktop-cli plugin --profile desktop remove ${UPSTREAM}`,
    `desktop-cli plugin --profile desktop add -w ${link}`,
  ])
  for (const profile of [web, desktop]) {
    assert.deepEqual(bridgesOf(profile), { dependencies: [NEW_NAME], bundles: [NEW_NAME] }, profile)
    assert.equal(existsSync(join(profile, 'node_modules', '@natgurlain', 'dsh-bridge-browser')), false, profile)
    const patch = join(profile, 'cordis.patch.yml')
    assert.equal(readFileSync(patch, 'utf8'), SAVED_SETTINGS.replace(OLD_NAME, NEW_NAME), profile)
    const { entry, warnings } = composedBridge(join(box.dshHome, 'cordis.patch.yml'), patch)
    assert.equal(entry.config.autoReview, false, profile)
    assert.deepEqual(warnings, [], profile)
  }
  assert.equal(readFileSync(join(box.dshHome, 'cordis.patch.yml'), 'utf8'), SAVED_SETTINGS.replace(OLD_NAME, NEW_NAME))
  assert.match(result.stdout, /Saved bridge settings now name dsh-browser-agent: .*profiles\/web\/cordis\.patch\.yml \(1\)/u)
  assert.match(result.stdout, /• web profile: registered/u)
  assert.match(result.stdout, /• DeepSeek Harness desktop app: registered/u)

  // Installing again is a plain update: nothing to remove, nothing left to rewrite.
  const before = box.calls().length
  const again = box.install()
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.deepEqual(box.calls().slice(before).filter(line => /^(dsh|desktop-cli) /u.test(line)), [
    `dsh plugin --profile web add -w ${link}`,
    `desktop-cli plugin --profile desktop add -w ${link}`,
  ])
  assert.doesNotMatch(again.stdout, /Saved bridge settings now name/u)
  for (const profile of [web, desktop]) assert.deepEqual(bridgesOf(profile), { dependencies: [NEW_NAME], bundles: [NEW_NAME] })
})

test('install with the desktop app skipped: the desktop profile and the shared home patch keep the old name', {
  skip: noShell, timeout: 600_000,
}, async (t) => {
  const box = checkout(t)
  const web = await seedProfile(box.dshHome, 'web', box.bridge, [OLD_NAME])
  const desktop = await seedProfile(box.dshHome, 'desktop', box.bridge, [OLD_NAME])
  writeFileSync(join(box.dshHome, 'cordis.patch.yml'), SAVED_SETTINGS)

  const result = box.install()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(bridgesOf(web), { dependencies: [NEW_NAME], bundles: [NEW_NAME] })
  assert.equal(readFileSync(join(web, 'cordis.patch.yml'), 'utf8'), SAVED_SETTINGS.replace(OLD_NAME, NEW_NAME))
  // Not re-registered, so it still runs the old package, which its rows and the home rows must keep matching.
  assert.deepEqual(bridgesOf(desktop), { dependencies: [OLD_NAME], bundles: [OLD_NAME] })
  assert.equal(readFileSync(join(desktop, 'cordis.patch.yml'), 'utf8'), SAVED_SETTINGS)
  assert.equal(readFileSync(join(box.dshHome, 'cordis.patch.yml'), 'utf8'), SAVED_SETTINGS)
})
