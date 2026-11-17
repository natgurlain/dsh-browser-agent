// The release path of scripts/install.sh and scripts/uninstall.sh against a local stand-in
// for GitHub Releases (scripts/lib/local-release.mjs): a tagged release is downloaded,
// checked against its SHA256SUMS, and only then unpacked or run.
//
// Most cases use a stub release whose payload only records that it ran, so "nothing ran"
// is observable. Two use the real artifacts from scripts/package-release.mjs; the full
// build-and-register dry run is the last test and runs only with DSH_RELEASE_E2E=1
// (see RELEASING.md).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { run, serveReleases } from '../lib/local-release.mjs'
import { assetNames, createTarGz, writeChecksums, writeInstallerAssets } from '../package-release.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const installer = join(root, 'scripts', 'install.sh')
const uninstaller = join(root, 'scripts', 'uninstall.sh')
const skip = process.platform === 'win32' ? 'bash installers are not used on Windows' : false
const TOKEN = 'ghp_localReleaseTestToken0123456789'

/** A private sandbox: HOME, DSH_HOME, TMPDIR, and an environment with no GitHub credentials. */
function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-release-install-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'home')
  const dshHome = join(home, '.dsh')
  const temporary = join(base, 'tmp')
  const ghConfig = join(base, 'gh-config')
  for (const dir of [home, temporary, ghConfig]) mkdirSync(dir, { recursive: true })
  const env = { ...process.env, HOME: home, DSH_HOME: dshHome, TMPDIR: temporary, GH_CONFIG_DIR: ghConfig,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', DSH_BROWSER_NO_LAUNCH: '1',
    // No desktop app unless a test builds one; a real one on this machine is never touched.
    DSH_DESKTOP_APP: 'none' }
  for (const name of Object.keys(env)) {
    // The version-manager variables would let the installer find this machine's own Node installs.
    if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|DSH_BROWSER_(?!NO_LAUNCH).*|DSH_INSTALL_BROWSER|ASDF_DATA_DIR|NVM_DIR|FNM_DIR|VOLTA_HOME|MISE_DATA_DIR|XDG_DATA_HOME)$/.test(name)) delete env[name]
  }
  // One language per run: English here, whatever the locale of the machine running the tests.
  env.DSH_BROWSER_LANG = 'en'
  return { base, home, dshHome, temporary, env, managed: join(dshHome, 'dsh-browser'), ran: join(base, 'payload-ran') }
}

/**
 * A release whose source archive is a minimal workspace: its scripts/install.sh (the second
 * stage the real installer hands over to) only appends a line to $STUB_RAN.
 */
function stubRelease(base, tag) {
  const dir = join(base, `release-${tag}`)
  mkdirSync(dir, { recursive: true })
  const names = assetNames(tag)
  const file = (name, text, mode = 0o644) => ({ name: `dsh-browser-${tag}/${name}`, data: Buffer.from(text), mode })
  writeFileSync(join(dir, names.sourceTar), createTarGz([
    file('package.json', JSON.stringify({ name: 'dsh-browser', version: tag.slice(1) })),
    file('pnpm-lock.yaml', ''),
    file('extensions/dsh-browser/package.json', '{}'),
    file('packages/browser/bridge-browser/package.json', '{}'),
    file('scripts/install.sh',
      `#!/bin/bash\nprintf 'install ${tag} bootstrapped=%s args=%s\\n' "\${DSH_BROWSER_BOOTSTRAPPED:-}" "$*" >>"$STUB_RAN"\n`, 0o755),
  ], { mtime: 1_700_000_000 }))
  writeFileSync(join(dir, 'uninstall.mjs'),
    `import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.STUB_RAN, 'uninstall ${tag} ' + process.argv.slice(2).join(' ') + '\\n')\n`)
  writeChecksums([join(dir, names.sourceTar), join(dir, 'uninstall.mjs')], join(dir, 'SHA256SUMS'))
  return dir
}

async function serve(t, options) {
  const server = await serveReleases(options)
  t.after(() => server.close())
  return server
}

/** Run install.sh the way the one-liner does: piped into bash. */
function pipedInstall(box, server, args = [], extraEnv = {}) {
  return run('bash', ['-s', '--', ...args], {
    env: { ...box.env, DSH_BROWSER_GITHUB_URL: server.url, DSH_BROWSER_GITHUB_API_URL: server.apiUrl, STUB_RAN: box.ran, ...extraEnv },
    cwd: box.base, input: readFileSync(installer),
  })
}

function ranLines(box) {
  return existsSync(box.ran) ? readFileSync(box.ran, 'utf8').trim().split('\n') : []
}

function refused(box, result, pattern) {
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, pattern)
  assert.deepEqual(ranLines(box), [], 'no part of the download may run')
  assert.equal(existsSync(box.managed), false, 'nothing may be unpacked into the managed root')
  assert.deepEqual(readdirSync(box.temporary), [], 'the download directory is removed')
}

test('happy path: the latest release is verified, unpacked and its installer run', { skip }, async (t) => {
  const box = sandbox(t)
  const server = await serve(t, { releases: { 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9' })
  const result = await pipedInstall(box, server)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /Verified: 1 file\(s\) of v9\.9\.9 match SHA256SUMS/)
  assert.deepEqual(ranLines(box), ['install v9.9.9 bootstrapped=1 args='])
  assert.equal(readFileSync(join(box.managed, '.managed-by-install-sh'), 'utf8'), 'release v9.9.9 (SHA256SUMS verified)\n')
  assert.equal(JSON.parse(readFileSync(join(box.managed, 'package.json'), 'utf8')).version, '9.9.9')
  assert.deepEqual(server.paths(), [
    'releases/latest', 'releases/tag/v9.9.9',
    'releases/download/v9.9.9/SHA256SUMS', 'releases/download/v9.9.9/dsh-browser-source-v9.9.9.tar.gz',
  ])
  assert.deepEqual(readdirSync(box.temporary), [])
})

test('happy path, two-step form: a downloaded install.sh run as a file does the same', { skip }, async (t) => {
  const box = sandbox(t)
  const server = await serve(t, { releases: { 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9' })
  const copy = join(box.base, 'downloads', 'install.sh')
  mkdirSync(dirname(copy))
  writeFileSync(copy, readFileSync(installer))
  const result = await run('bash', [copy, '--release', 'v9.9.9'], {
    env: { ...box.env, DSH_BROWSER_GITHUB_URL: server.url, STUB_RAN: box.ran }, cwd: box.base,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(ranLines(box), ['install v9.9.9 bootstrapped=1 args='])
})

test('checksum mismatch: a tampered archive is refused before it is unpacked', { skip }, async (t) => {
  const box = sandbox(t)
  const release = stubRelease(box.base, 'v9.9.9')
  appendFileSync(join(release, assetNames('v9.9.9').sourceTar), 'tampered')
  const server = await serve(t, { releases: { 'v9.9.9': release }, latest: 'v9.9.9' })
  refused(box, await pipedInstall(box, server), /SHA-256 mismatch for dsh-browser-source-v9\.9\.9\.tar\.gz/)
})

test('checksum mismatch leaves an existing managed install exactly as it was', { skip }, async (t) => {
  const box = sandbox(t)
  mkdirSync(box.managed, { recursive: true })
  writeFileSync(join(box.managed, '.managed-by-install-sh'), 'release v9.9.8 (SHA256SUMS verified)\n')
  writeFileSync(join(box.managed, 'kept.txt'), 'previous install')
  const release = stubRelease(box.base, 'v9.9.9')
  appendFileSync(join(release, assetNames('v9.9.9').sourceTar), 'tampered')
  const server = await serve(t, { releases: { 'v9.9.9': release }, latest: 'v9.9.9' })
  const result = await pipedInstall(box, server)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.deepEqual(readdirSync(box.managed).sort(), ['.managed-by-install-sh', 'kept.txt'])
  assert.equal(readFileSync(join(box.managed, '.managed-by-install-sh'), 'utf8'), 'release v9.9.8 (SHA256SUMS verified)\n')
  assert.deepEqual(ranLines(box), [])
})

test('missing SHA256SUMS: a release without checksums is refused', { skip }, async (t) => {
  const box = sandbox(t)
  const release = stubRelease(box.base, 'v9.9.9')
  rmSync(join(release, 'SHA256SUMS'))
  const server = await serve(t, { releases: { 'v9.9.9': release }, latest: 'v9.9.9' })
  refused(box, await pipedInstall(box, server), /Release v9\.9\.9 has no SHA256SUMS/)
  assert.equal(server.paths().some(path => path.endsWith('.tar.gz')), false, 'the archive is not even requested')
})

test('SHA256SUMS without a line for the archive is refused', { skip }, async (t) => {
  const box = sandbox(t)
  const release = stubRelease(box.base, 'v9.9.9')
  writeChecksums([join(release, 'uninstall.mjs')], join(release, 'SHA256SUMS'))
  const server = await serve(t, { releases: { 'v9.9.9': release }, latest: 'v9.9.9' })
  refused(box, await pipedInstall(box, server), /has no single digest for dsh-browser-source-v9\.9\.9\.tar\.gz/)
})

test('truncated download: a short archive body is a download error, not an install', { skip }, async (t) => {
  const box = sandbox(t)
  const names = assetNames('v9.9.9')
  const server = await serve(t, {
    releases: { 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9', truncate: [names.sourceTar],
  })
  refused(box, await pipedInstall(box, server), /Downloading dsh-browser-source-v9\.9\.9\.tar\.gz failed/)
})

test('truncated download: a short SHA256SUMS is a download error', { skip }, async (t) => {
  const box = sandbox(t)
  const server = await serve(t, {
    releases: { 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9', truncate: ['SHA256SUMS'],
  })
  refused(box, await pipedInstall(box, server), /Downloading SHA256SUMS failed/)
})

test('pinned version: --release and DSH_BROWSER_VERSION select that tag, not the latest', { skip }, async (t) => {
  for (const [label, args, extraEnv] of [
    ['flag', ['--release', 'v9.9.8'], {}],
    ['flag=', ['--release=v9.9.8'], {}],
    ['environment, bare number', [], { DSH_BROWSER_VERSION: '9.9.8' }],
  ]) {
    const box = sandbox(t)
    const server = await serve(t, {
      releases: { 'v9.9.8': stubRelease(box.base, 'v9.9.8'), 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9',
    })
    const result = await pipedInstall(box, server, args, extraEnv)
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`)
    assert.deepEqual(ranLines(box), ['install v9.9.8 bootstrapped=1 args='], label)
    assert.equal(server.paths().includes('releases/latest'), false, `${label}: latest is never consulted`)
    assert.equal(server.paths().some(path => path.includes('v9.9.9')), false, label)
  }
})

test('pinned version: an unknown or malformed tag is refused', { skip }, async (t) => {
  const box = sandbox(t)
  const server = await serve(t, { releases: { 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9' })
  refused(box, await pipedInstall(box, server, ['--release', 'v1.0.0']), /Release v1\.0\.0 .* is not reachable anonymously/)
  refused(box, await pipedInstall(box, server, ['--release', 'main']), /Not a release tag: main/)
  refused(box, await pipedInstall(box, server, ['--release', '../../etc']), /Not a release tag/)
})

test('--release inside an installed copy downloads the release instead of reinstalling the copy', { skip }, async (t) => {
  const box = sandbox(t)
  // A managed install of an older release whose install.sh is the real one (the update path).
  for (const dir of ['scripts', 'extensions/dsh-browser', 'packages/browser/bridge-browser']) {
    mkdirSync(join(box.managed, dir), { recursive: true })
  }
  for (const name of ['package.json', 'pnpm-lock.yaml', 'extensions/dsh-browser/package.json',
    'packages/browser/bridge-browser/package.json', '.managed-by-install-sh']) {
    writeFileSync(join(box.managed, name), '{}')
  }
  writeFileSync(join(box.managed, 'scripts', 'install.sh'), readFileSync(installer))
  const server = await serve(t, { releases: { 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9' })
  const result = await run('bash', [join(box.managed, 'scripts', 'install.sh'), '--release', 'latest'], {
    env: { ...box.env, DSH_BROWSER_GITHUB_URL: server.url, STUB_RAN: box.ran }, cwd: box.base,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(ranLines(box), ['install v9.9.9 bootstrapped=1 args='])
  assert.equal(JSON.parse(readFileSync(join(box.managed, 'package.json'), 'utf8')).version, '9.9.9')
})

test('local checkout: no option means no download at all', { skip }, async (t) => {
  const box = sandbox(t)
  const checkout = join(box.base, 'checkout')
  for (const dir of ['scripts', 'extensions/dsh-browser', 'packages/browser/bridge-browser']) {
    mkdirSync(join(checkout, dir), { recursive: true })
  }
  for (const name of ['package.json', 'pnpm-lock.yaml', 'extensions/dsh-browser/package.json',
    'packages/browser/bridge-browser/package.json']) {
    writeFileSync(join(checkout, name), '{}')
  }
  writeFileSync(join(checkout, 'scripts', 'install.sh'), readFileSync(installer))
  // The build is not what this test is about: a pnpm that fails ends the run at step 1.
  const bin = join(box.base, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\n[ "$1" = --version ] && exit 0\nexit 3\n')
  chmodSync(join(bin, 'pnpm'), 0o755)
  const server = await serve(t, { releases: { 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9' })
  const result = await run('bash', [join(checkout, 'scripts', 'install.sh')], {
    env: { ...box.env, PATH: `${bin}${delimiter}${process.env.PATH}`, DSH_BROWSER_GITHUB_URL: server.url, STUB_RAN: box.ran },
    cwd: box.base,
  })
  assert.equal(result.status, 3, result.stdout + result.stderr)
  assert.match(result.stdout, /Installing from this local checkout; nothing is downloaded/)
  assert.deepEqual(server.requests, [])
  assert.equal(existsSync(box.managed), false)
})

/**
 * A minimal checkout holding the real install.sh, plus a bin directory of stub commands.
 * `complete` adds what the steps after the build read, so the installer can run to its end;
 * `path` replaces the inherited PATH behind the stubs.
 */
function stubCheckout(box, stubs, { complete = false, env = {}, path = process.env.PATH } = {}) {
  const checkout = join(box.base, 'checkout')
  for (const dir of ['scripts', 'extensions/dsh-browser', 'packages/browser/bridge-browser']) {
    mkdirSync(join(checkout, dir), { recursive: true })
  }
  for (const name of ['pnpm-lock.yaml', 'extensions/dsh-browser/package.json',
    'packages/browser/bridge-browser/package.json']) {
    writeFileSync(join(checkout, name), '{}')
  }
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.7.0+sha512.abc' }))
  writeFileSync(join(checkout, 'scripts', 'install.sh'), readFileSync(installer))
  if (complete) {
    writeFileSync(join(checkout, 'packages/browser/bridge-browser/package.json'),
      JSON.stringify({ name: 'dsh-browser-agent', engines: { dsh: '^0.2.2-rc.2' } }))
    mkdirSync(join(checkout, 'extensions/dsh-browser/dist'))
    writeFileSync(join(checkout, 'extensions/dsh-browser/dist/manifest.json'), '{}')
    for (const name of ['write-install-info.mjs', 'provision-bridge-token.mjs', 'migrate-bridge-name.mjs']) {
      copyFileSync(join(root, 'scripts', name), join(checkout, 'scripts', name))
    }
  }
  const bin = join(box.base, 'bin')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  return run('bash', [join(checkout, 'scripts', 'install.sh')], {
    env: { ...box.env, PATH: `${bin}${delimiter}${path}`, STUB_RAN: box.ran, ...env },
    cwd: box.base,
  })
}

// A version-manager shim with no version set: present on PATH, exits 126 on every call.
const BROKEN = 'echo "No version is set for command $(basename "$0")" >&2\nexit 126'
// Answers --version, records every other call and fails it so the run ends at step 1.
const RECORDING = '[ "$1" = --version ] && exit 0\nprintf \'%s %s\\n\' "$(basename "$0")" "$*" >>"$STUB_RAN"\nexit 7'

test('broken pnpm on PATH: the install proceeds through corepack', { skip }, async (t) => {
  const box = sandbox(t)
  const result = await stubCheckout(box, { pnpm: BROKEN, corepack: RECORDING })
  assert.equal(result.status, 7, result.stdout + result.stderr)
  assert.match(result.stdout, /pnpm on PATH does not run with this Node; using Corepack instead\./)
  assert.deepEqual(ranLines(box), ['corepack pnpm install --frozen-lockfile'])
  assert.match(result.stderr, /Error: Installing dependencies failed \(exit code 7\)\./)
})

test('broken pnpm and corepack: the install proceeds through npx with the pinned pnpm', { skip }, async (t) => {
  const box = sandbox(t)
  const result = await stubCheckout(box, { pnpm: BROKEN, corepack: BROKEN, npx: RECORDING })
  assert.equal(result.status, 7, result.stdout + result.stderr)
  assert.match(result.stdout, /using npx pnpm@11\.7\.0 instead\./)
  assert.deepEqual(ranLines(box), ['npx --yes pnpm@11.7.0 install --frozen-lockfile'])
})

test('broken pnpm with no usable corepack or npx stops before the build', { skip }, async (t) => {
  const box = sandbox(t)
  const result = await stubCheckout(box, { pnpm: BROKEN, corepack: BROKEN, npx: BROKEN })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /Error: pnpm on PATH does not run, and neither Corepack nor npx is usable/)
  assert.doesNotMatch(result.stdout, /\[1\/4\]/)
})

test('working pnpm on PATH is used as is, with no fallback notice', { skip }, async (t) => {
  const box = sandbox(t)
  const result = await stubCheckout(box, { pnpm: RECORDING, corepack: RECORDING })
  assert.equal(result.status, 7, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout, /instead/)
  assert.deepEqual(ranLines(box), ['pnpm install --frozen-lockfile'])
})

// Succeeds at everything and records each call with the node it would run on.
const WORKING_PNPM = '[ "$1" = --version ] && exit 0\nprintf \'pnpm[%s] %s\\n\' "$(command -v node)" "$*" >>"$STUB_RAN"'
// A node older than the 24.9.0 the build needs.
const OLD_NODE = 'printf 18.19.0'
const BRIDGE_LINK = box => `dsh-browser-agent@link:${join(box.base, 'checkout', 'packages/browser/bridge-browser')}`

function executable(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o755)
  return path
}

/**
 * A stand-in for "DeepSeek Harness.app" with the layout the installer was written against,
 * plus the desktop profile the app creates on first start. The bundled CLI records its
 * arguments; `cli` selects what `plugin --profile desktop add` then does.
 */
function desktopApp(box, { cli = 'ok', node = false, pnpm = false, profile = true } = {}) {
  const app = join(box.base, 'Applications', 'DeepSeek Harness.app')
  const runtime = join(app, 'Contents', 'Resources', 'runtime')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'versions.json'), JSON.stringify({ schemaVersion: 1, node: '24.21.0', pnpm: '11.28.5' }))
  const outcome = {
    ok: 'exit 0',
    reject: 'echo \'dsh: installation rejected: Plugin dsh-browser-agent@0.0.7 is incompatible with dsh 0.2.2-rc.1: requirements {"engines.dsh":"^0.2.2-rc.2"}; to override run: dsh plugin allow-version dsh-browser-agent --accept-risk\' >&2\nexit 1',
    fail: 'echo "dsh: profile lock is held" >&2\nexit 5',
  }[cli]
  executable(join(runtime, 'cli', 'bin', 'dsh'),
    `#!/bin/sh\nprintf 'desktop-cli %s\\n' "$*" >>"$STUB_RAN"\n${outcome}\n`)
  const bundledNode = join(runtime, 'bin', 'node')
  if (node) executable(bundledNode, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)
  const bundledPnpm = join(runtime, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  if (pnpm) {
    executable(bundledPnpm, `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] !== '--version') appendFileSync(process.env.STUB_RAN, 'bundled-pnpm ' + args.join(' ') + '\\n')
`)
  }
  if (profile) {
    mkdirSync(join(box.dshHome, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(box.dshHome, 'profiles', 'desktop', 'package.json'), '{}')
  }
  return { app, bundledNode, bundledPnpm, env: { DSH_DESKTOP_APP: app } }
}

const cliCalls = box => ranLines(box).filter(line => line.startsWith('desktop-cli '))
const webRegistered = box => ranLines(box).some(line => line.endsWith(`exec dsh plugin --profile web add -w ${BRIDGE_LINK(box)}`))

test('desktop app present and compatible: registered in both profiles, the summary leads with the app', { skip }, async (t) => {
  const box = sandbox(t)
  const desktop = desktopApp(box)
  const result = await stubCheckout(box, { pnpm: WORKING_PNPM }, { complete: true, env: desktop.env })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(webRegistered(box), true, ranLines(box).join('\n'))
  assert.deepEqual(cliCalls(box), [`desktop-cli plugin --profile desktop add -w ${BRIDGE_LINK(box)}`])
  assert.match(result.stdout, /• web profile: registered/)
  assert.match(result.stdout, /• DeepSeek Harness desktop app: registered \(.*DeepSeek Harness\.app\)/)
  const lead = result.stdout.indexOf('• Open DeepSeek Harness (restart it if it was running)')
  const alternative = result.stdout.indexOf('• Alternative without the desktop app (the separate web profile')
  assert.ok(lead > 0 && alternative > lead, result.stdout)
  assert.ok(result.stdout.indexOf('pnpm start') > alternative, 'pnpm start is only the alternative')
  assert.match(result.stdout, /npx @deepseek-ai\/dsh@0\.2\.2-rc\.2 web/)
  assert.doesNotMatch(result.stdout + result.stderr, /WARNING/)
  assert.equal(existsSync(join(box.dshHome, 'browser-extension', 'install-info.json')), true)
})

test('desktop app running: the plugin is still added and the user is told to quit and reopen it', { skip }, async (t) => {
  const box = sandbox(t)
  const desktop = desktopApp(box)
  const main = join(desktop.app, 'Contents', 'MacOS', 'DeepSeek Harness')
  mkdirSync(dirname(main), { recursive: true })
  symlinkSync(process.execPath, main)
  const app = spawn(main, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  t.after(() => app.kill('SIGKILL'))
  const result = await stubCheckout(box, { pnpm: WORKING_PNPM }, { complete: true, env: desktop.env })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(cliCalls(box).length, 1)
  assert.match(result.stdout, /DeepSeek Harness is running: the plugin was added, and it takes effect after you quit and reopen the app\./)
  assert.match(result.stdout, /• Open DeepSeek Harness \(it is running now: quit it and open it again\)/)
  assert.equal(app.exitCode, null, 'the installer does not stop the app')
})

test('desktop app that rejects the plugin version: web is registered, exit 0, a warning, never the override', { skip }, async (t) => {
  const box = sandbox(t)
  const desktop = desktopApp(box, { cli: 'reject' })
  const result = await stubCheckout(box, { pnpm: WORKING_PNPM }, { complete: true, env: desktop.env })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(webRegistered(box), true)
  assert.deepEqual(cliCalls(box), [`desktop-cli plugin --profile desktop add -w ${BRIDGE_LINK(box)}`])
  assert.equal(ranLines(box).some(line => /allow-version|accept-risk/.test(line)), false, 'the override is never invoked')
  assert.match(result.stderr, /WARNING: the DeepSeek Harness app has DSH 0\.2\.2-rc\.1 and this plugin supports \^0\.2\.2-rc\.2, so the app rejected it\. Update the DeepSeek Harness app, then run this installer again\./)
  assert.match(result.stderr, /exit code: 1/)
  assert.match(result.stderr, /command: .*cli\/bin\/dsh plugin --profile desktop add -w /)
  assert.match(result.stdout, /• web profile: registered/)
  assert.match(result.stdout, /• DeepSeek Harness desktop app: NOT registered\. WARNING: the app has DSH 0\.2\.2-rc\.1 and this plugin supports \^0\.2\.2-rc\.2\. Update the DeepSeek Harness app, then run this installer again\./)
  assert.doesNotMatch(result.stdout, /• Open DeepSeek Harness/)
  assert.match(result.stdout, /• Start the pinned version: cd .* && pnpm start/)
  assert.match(result.stdout, /Note: this starts the separate web profile/)
})

test('desktop app whose CLI fails for another reason: everything else is installed, then exit 1', { skip }, async (t) => {
  const box = sandbox(t)
  const desktop = desktopApp(box, { cli: 'fail' })
  const result = await stubCheckout(box, { pnpm: WORKING_PNPM }, { complete: true, env: desktop.env })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /WARNING: registering with the DeepSeek Harness desktop app failed/)
  assert.match(result.stderr, /exit code: 5/)
  assert.match(result.stderr, /dsh: profile lock is held/)
  assert.match(result.stdout, /• DeepSeek Harness desktop app: NOT registered\. WARNING: its bundled CLI failed/)
  assert.equal(existsSync(join(box.dshHome, 'browser-extension', 'manifest.json')), true)
})

test('desktop app absent, or never started: the web profile only, summary as before', { skip }, async (t) => {
  const box = sandbox(t)
  const result = await stubCheckout(box, { pnpm: WORKING_PNPM }, { complete: true })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(webRegistered(box), true)
  assert.deepEqual(cliCalls(box), [])
  assert.match(result.stdout, /• web profile: registered/)
  assert.match(result.stdout, /• DeepSeek Harness desktop app: skipped, /)
  assert.match(result.stdout, /• Start the pinned version: cd .* && pnpm start/)
  assert.match(result.stdout, /• Or start the pinned version directly: npx @deepseek-ai\/dsh@0\.2\.2-rc\.2 web/)
  assert.doesNotMatch(result.stdout, /Open DeepSeek Harness/)

  const unopened = sandbox(t)
  const desktop = desktopApp(unopened, { profile: false })
  const skipped = await stubCheckout(unopened, { pnpm: WORKING_PNPM }, { complete: true, env: desktop.env })
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr)
  assert.deepEqual(cliCalls(unopened), [])
  assert.match(skipped.stdout, /• DeepSeek Harness desktop app: skipped, .*profiles\/desktop does not exist\. Open the app once, then run this installer again\./)

  const missing = sandbox(t)
  const wrong = await stubCheckout(missing, { pnpm: WORKING_PNPM }, { complete: true, env: { DSH_DESKTOP_APP: join(missing.base, 'nowhere.app') } })
  assert.equal(wrong.status, 0, wrong.stdout + wrong.stderr)
  assert.match(wrong.stdout, /DSH_DESKTOP_APP names a directory that does not exist/)
})

test('node on PATH too old, the app bundles one: the build runs on the bundled Node', { skip }, async (t) => {
  const box = sandbox(t)
  const desktop = desktopApp(box, { node: true })
  const result = await stubCheckout(box, { node: OLD_NODE, pnpm: WORKING_PNPM }, { complete: true, env: desktop.env })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, new RegExp(`No usable Node\\.js on PATH; using Node\\.js ${process.versions.node.replaceAll('.', '\\.')} from the DeepSeek Harness app \\(for this install only\\): .*runtime/bin/node`))
  assert.equal(ranLines(box)[0], `pnpm[${desktop.bundledNode}] install --frozen-lockfile`)
  assert.equal(JSON.parse(readFileSync(join(box.dshHome, 'browser-extension', 'install-info.json'), 'utf8')).mode, 'checkout')
})

test('a build that fails on the bundled Node is retried on the next installed Node', { skip }, async (t) => {
  const box = sandbox(t)
  const desktop = desktopApp(box, { node: true })
  const managed = executable(join(box.home, '.asdf', 'installs', 'nodejs', '24.11.0', 'bin', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)
  // Fails whenever the node in use is the app's.
  const pnpm = `${WORKING_PNPM}\ncase "$(command -v node)" in *"DeepSeek Harness.app"*) echo "electron cannot build this" >&2; exit 9 ;; esac`
  const result = await stubCheckout(box, { node: OLD_NODE, pnpm }, { complete: true, env: desktop.env })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stderr, /electron cannot build this/)
  assert.match(result.stdout, /using Node\.js .* from asdf \(for this install only\): .*\.asdf\/installs\/nodejs\/24\.11\.0\/bin\/node/)
  assert.match(result.stdout, /That step failed with the Node\.js bundled in the DeepSeek Harness app; retrying/)
  assert.deepEqual(ranLines(box).slice(0, 2), [
    `pnpm[${desktop.bundledNode}] install --frozen-lockfile`, `pnpm[${managed}] install --frozen-lockfile`,
  ])
})

test('node on PATH too old, a version manager already has a suitable one: that one is used', { skip }, async (t) => {
  const box = sandbox(t)
  const managed = executable(join(box.home, '.nvm', 'versions', 'node', 'v24.12.0', 'bin', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)
  executable(join(box.home, '.nvm', 'versions', 'node', 'v18.19.0', 'bin', 'node'), '#!/bin/sh\nprintf 18.19.0\n')
  const result = await stubCheckout(box, { node: OLD_NODE, pnpm: RECORDING })
  assert.equal(result.status, 7, result.stdout + result.stderr)
  assert.match(result.stdout, /using Node\.js .* from nvm \(for this install only\): .*v24\.12\.0\/bin\/node/)
  assert.equal(managed.includes('v24.12.0'), true)
})

test('node on PATH too old and nothing else installed: stops with the commands for the tools present', { skip }, async (t) => {
  const box = sandbox(t)
  const result = await stubCheckout(box, { node: OLD_NODE, pnpm: RECORDING, asdf: 'exit 0', brew: 'exit 0' })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /Error: Node\.js 24\.9\.0 or newer is required; node on PATH is 18\.19\.0 \(.*\/bin\/node\)\./)
  assert.match(result.stderr, /asdf: {3}asdf plugin add nodejs; asdf install nodejs 24\.11\.0; asdf set nodejs 24\.11\.0/)
  assert.match(result.stderr, /brew: {3}brew install node/)
  assert.doesNotMatch(result.stdout, /\[1\/4\]/)
  assert.deepEqual(ranLines(box), [], 'nothing is installed or built')
})

test('broken pnpm on PATH, the app bundles one: the bundled pnpm is preferred over Corepack', { skip }, async (t) => {
  const box = sandbox(t)
  const desktop = desktopApp(box, { pnpm: true })
  const result = await stubCheckout(box, { pnpm: BROKEN, corepack: RECORDING }, { complete: true, env: desktop.env })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /pnpm on PATH does not run with this Node; using the pnpm bundled in the DeepSeek Harness app instead: .*pnpm\.mjs/)
  assert.equal(ranLines(box)[0], 'bundled-pnpm install --frozen-lockfile')
  assert.equal(ranLines(box).some(line => line.startsWith('corepack ')), false)
})

/** A PATH holding only the named system tools, so no browser of this machine is on it. */
function toolsOnly(box) {
  const tools = join(box.base, 'tools')
  mkdirSync(tools)
  for (const name of ['bash', 'sh', 'rsync', 'mktemp', 'cat', 'tail', 'head', 'cut', 'sleep', 'rm', 'mkdir', 'dirname',
    'basename', 'uname', 'id', 'sed', 'grep', 'awk', 'tr', 'sort', 'ls', 'find', 'ps', 'chmod', 'cp', 'mv', 'env']) {
    const found = process.env.PATH.split(delimiter).map(dir => join(dir, name)).find(path => existsSync(path))
    if (found) symlinkSync(found, join(tools, name))
  }
  symlinkSync(process.execPath, join(tools, 'node'))
  return tools
}

test('only Brave installed: nothing is installed, and the instructions say Brave and brave://extensions', {
  skip: skip || (process.platform === 'darwin' ? 'macOS detects browsers in /Applications, which a test cannot stage' : false),
}, async (t) => {
  const box = sandbox(t)
  const record = 'printf \'%s %s\\n\' "$(basename "$0")" "$*" >>"$STUB_RAN"'
  const result = await stubCheckout(box, {
    pnpm: WORKING_PNPM, 'brave-browser': record, 'apt-get': record, sudo: record, brew: record, dnf: record,
  }, {
    complete: true, path: toolsOnly(box),
    // The installer may open the browser, and is even allowed to install one.
    env: { DSH_BROWSER_NO_LAUNCH: '0', DSH_INSTALL_BROWSER: '1', DISPLAY: ':99' },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const calls = ranLines(box).filter(line => !line.startsWith('pnpm['))
  assert.deepEqual(calls, ['brave-browser chrome://extensions'], 'only Brave is started; no package manager runs')
  assert.match(result.stdout, /\[4\/4\] Prepare the extension and open Brave/)
  assert.match(result.stdout, /Brave Extensions \(brave:\/\/extensions\) is open\. Complete these steps:/)
  assert.doesNotMatch(result.stdout, /Google Chrome|chrome:\/\/extensions|was detected|DSH_INSTALL_BROWSER/)
})

test('branch opt-in: --unverified-branch installs a branch archive and says it is unverified', { skip }, async (t) => {
  const box = sandbox(t)
  const release = stubRelease(box.base, 'v9.9.9')
  const server = await serve(t, {
    releases: { 'v9.9.9': release }, latest: 'v9.9.9',
    branches: { 'feature/dev': join(release, assetNames('v9.9.9').sourceTar) },
  })
  const result = await pipedInstall(box, server, ['--unverified-branch', 'feature/dev'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /WARNING: installing branch feature\/dev .* NOT verified/)
  assert.deepEqual(server.paths(), ['archive/refs/heads/feature/dev.tar.gz'])
  assert.equal(readFileSync(join(box.managed, '.managed-by-install-sh'), 'utf8'), 'branch feature/dev (unverified)\n')
  assert.deepEqual(ranLines(box), ['install v9.9.9 bootstrapped=1 args='])
})

test('branch opt-in: without it no branch archive is ever requested, and it cannot be combined with a release', { skip }, async (t) => {
  const box = sandbox(t)
  const release = stubRelease(box.base, 'v9.9.9')
  const server = await serve(t, {
    releases: { 'v9.9.9': release }, latest: 'v9.9.9', branches: { main: join(release, assetNames('v9.9.9').sourceTar) },
  })
  assert.equal((await pipedInstall(box, server)).status, 0)
  assert.equal(server.paths().some(path => path.startsWith('archive/')), false)

  const other = sandbox(t)
  refused(other, await pipedInstall(other, server, ['--release', 'v9.9.9', '--unverified-branch', 'main']), /cannot be combined/)
  refused(other, await pipedInstall(other, server, [], { DSH_BROWSER_UNVERIFIED_BRANCH: 'no/such' }), /cannot be downloaded anonymously/)
  refused(other, await pipedInstall(other, server, ['--unverified-branch', '../x']), /Not a usable branch name/)
})

test('private repository without credentials: the installer says what to do', { skip }, async (t) => {
  const box = sandbox(t)
  const server = await serve(t, { releases: { 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9', private: true })
  // No gh on PATH is not guaranteed here; an empty GH_CONFIG_DIR makes `gh auth status` fail.
  const result = await pipedInstall(box, server)
  refused(box, result, /not reachable anonymously: the repository is private/)
  assert.match(result.stderr, /gh auth login/)
  assert.match(result.stderr, /DSH_BROWSER_GITHUB_TOKEN/)
  assert.match(result.stderr, /\.\/scripts\/install\.sh from the checkout/)
})

test('private repository with DSH_BROWSER_GITHUB_TOKEN: API download, still verified, token never printed', { skip }, async (t) => {
  const box = sandbox(t)
  const release = stubRelease(box.base, 'v9.9.9')
  const server = await serve(t, { releases: { 'v9.9.9': release }, latest: 'v9.9.9', private: true, token: TOKEN })
  const result = await pipedInstall(box, server, [], { DSH_BROWSER_GITHUB_TOKEN: TOKEN })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(ranLines(box), ['install v9.9.9 bootstrapped=1 args='])
  assert.equal((result.stdout + result.stderr).includes(TOKEN), false)
  assert.equal(server.requests.every(entry => entry.url.startsWith('/api/') && entry.authorization === `Bearer ${TOKEN}`), true)
  assert.equal(readFileSync(join(box.managed, '.managed-by-install-sh'), 'utf8').includes(TOKEN), false)

  // The same path fails closed on a tampered asset and on a wrong token.
  const tampered = sandbox(t)
  appendFileSync(join(release, assetNames('v9.9.9').sourceTar), 'tampered')
  refused(tampered, await pipedInstall(tampered, server, [], { DSH_BROWSER_GITHUB_TOKEN: TOKEN }), /SHA-256 mismatch/)
  const wrong = await pipedInstall(tampered, server, [], { DSH_BROWSER_GITHUB_TOKEN: 'ghp_wrong' })
  refused(tampered, wrong, /GitHub rejected DSH_BROWSER_GITHUB_TOKEN \(HTTP 401\)/)
  assert.equal((wrong.stdout + wrong.stderr).includes('ghp_wrong'), false)
})

test('private repository with an authenticated gh: gh downloads, the installer still verifies', { skip }, async (t) => {
  const box = sandbox(t)
  const release = stubRelease(box.base, 'v9.9.9')
  const bin = join(box.base, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), `#!/bin/bash
case "$1 $2" in
  "auth status") exit 0 ;;
  "release view") echo v9.9.9 ;;
  "release download")
    tag="$3"; shift 3
    while [ "$#" -gt 0 ]; do
      case "$1" in --pattern) pattern="$2"; shift 2 ;; --dir) dir="$2"; shift 2 ;; --repo) shift 2 ;; *) shift ;; esac
    done
    [ "$tag" = v9.9.9 ] && [ -f "$GH_STUB_RELEASE/$pattern" ] || { echo "no assets match the file pattern" >&2; exit 1; }
    cp "$GH_STUB_RELEASE/$pattern" "$dir/" ;;
  *) exit 2 ;;
esac
`)
  chmodSync(join(bin, 'gh'), 0o755)
  const server = await serve(t, { releases: { 'v9.9.9': release }, latest: 'v9.9.9', private: true })
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, GH_STUB_RELEASE: release }
  const result = await pipedInstall(box, server, [], env)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(ranLines(box), ['install v9.9.9 bootstrapped=1 args='])

  const tampered = sandbox(t)
  appendFileSync(join(release, assetNames('v9.9.9').sourceTar), 'tampered')
  refused(tampered, await pipedInstall(tampered, server, [], env), /SHA-256 mismatch/)
  rmSync(join(release, 'SHA256SUMS'))
  refused(tampered, await pipedInstall(tampered, server, [], env), /has no SHA256SUMS/)
})

test('download URLs must be HTTPS unless they are loopback', { skip }, async (t) => {
  const box = sandbox(t)
  const result = await run('bash', ['-s'], {
    env: { ...box.env, DSH_BROWSER_GITHUB_URL: 'http://example.invalid', STUB_RAN: box.ran }, cwd: box.base,
    input: readFileSync(installer),
  })
  refused(box, result, /Download URLs must use HTTPS/)
})

test('no release published yet is reported as such', { skip }, async (t) => {
  const box = sandbox(t)
  const server = await serve(t, { releases: {} })
  refused(box, await pipedInstall(box, server), /has not published a release yet/)
})

function pipedUninstall(box, server, args = [], extraEnv = {}) {
  return run('bash', ['-s', '--', ...args], {
    env: { ...box.env, DSH_BROWSER_GITHUB_URL: server.url, DSH_BROWSER_GITHUB_API_URL: server.apiUrl, STUB_RAN: box.ran, ...extraEnv },
    cwd: box.base, input: readFileSync(uninstaller),
  })
}

test('uninstall.sh: the downloaded uninstall.mjs runs only after it verified; --release is not forwarded', { skip }, async (t) => {
  const box = sandbox(t)
  const release = stubRelease(box.base, 'v9.9.9')
  const server = await serve(t, {
    releases: { 'v9.9.8': stubRelease(box.base, 'v9.9.8'), 'v9.9.9': release }, latest: 'v9.9.9',
  })
  const latest = await pipedUninstall(box, server, ['--dry-run'])
  assert.equal(latest.status, 0, latest.stdout + latest.stderr)
  const pinned = await pipedUninstall(box, server, ['--release', 'v9.9.8', '--home', '/some where'])
  assert.equal(pinned.status, 0, pinned.stdout + pinned.stderr)
  assert.deepEqual(ranLines(box), ['uninstall v9.9.9 --dry-run', 'uninstall v9.9.8 --home /some where'])
  assert.deepEqual(readdirSync(box.temporary), [])

  appendFileSync(join(release, 'uninstall.mjs'), '\n// tampered\n')
  const tampered = await pipedUninstall(box, server)
  assert.equal(tampered.status, 1, tampered.stdout + tampered.stderr)
  assert.match(tampered.stderr, /SHA-256 mismatch for uninstall\.mjs/)
  assert.equal(ranLines(box).length, 2, 'the tampered uninstaller did not run')
  assert.deepEqual(readdirSync(box.temporary), [])
})

// ---- One language per run ------------------------------------------------------------------
// Han characters, CJK punctuation and the full-width forms the Chinese messages use.
const CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯]/u
// Sentences only the English messages contain.
const ENGLISH_ONLY = ['Installing from this local checkout', 'Build the browser bridge', 'Register with DSH',
  'Registered with the web profile', 'Registering with the DeepSeek Harness desktop app', 'Build the browser extension',
  'Prepare the extension and open', 'Complete these steps', 'Enable “Developer mode”', 'Click “Load unpacked”',
  'DSH targets:', 'web profile: registered', 'desktop app: registered', 'After loading the extension',
  'Open DeepSeek Harness', 'Click the DeepSeek whale icon', 'discovers local dsh automatically',
  'Alternative without the desktop app', 'Star on GitHub']
const ENGLISH_FAILURES = ['Error:', 'WARNING', 'Full output:', 'exit code', 'Verified:', 'is required', 'was not found']
// The locale decides only when DSH_BROWSER_LANG is not set.
const LOCALE = { DSH_BROWSER_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: '' }
// Fails the first build step with exit code 3.
const FAILING_PNPM = '[ "$1" = --version ] && exit 0\necho "ERR_PNPM_OUTDATED_LOCKFILE" >&2\nexit 3'

/** The fullest run there is: desktop app present, every step succeeds. */
function fullInstall(t, env = {}) {
  const box = sandbox(t)
  const desktop = desktopApp(box)
  return stubCheckout(box, { pnpm: WORKING_PNPM }, { complete: true, env: { ...desktop.env, ...env } })
}

function assertNoEnglish(output) {
  for (const sentence of [...ENGLISH_ONLY, ...ENGLISH_FAILURES]) {
    assert.equal(output.includes(sentence), false, `${sentence}\n${output}`)
  }
}

test('language: an English run of the full install prints no Chinese at all', { skip }, async (t) => {
  const result = await fullInstall(t)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const output = result.stdout + result.stderr
  assert.doesNotMatch(output, CJK)
  for (const sentence of ENGLISH_ONLY) assert.equal(output.includes(sentence), true, `${sentence}\n${output}`)
  assert.match(result.stdout, /^1\. Enable “Developer mode”$/m)
  assert.match(result.stdout, /^• web profile: registered$/m)
  // Three spaces used to indent the second language; now only the extension path has them.
  const indented = result.stdout.split('\n').filter(line => /^ {3}\S/.test(line))
  assert.equal(indented.length, 1, result.stdout)
  assert.match(indented[0], /^ {3}\/.*\/\.dsh\/browser-extension$/)
})

test('language: DSH_BROWSER_LANG=zh prints the same run in Chinese only', { skip }, async (t) => {
  const english = await fullInstall(t)
  const result = await fullInstall(t, { DSH_BROWSER_LANG: 'zh' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assertNoEnglish(result.stdout + result.stderr)
  const lines = result.stdout.split('\n')
  for (const line of ['[1/4] 构建浏览器桥', '[2/4] 注册到 DSH（web profile 与桌面应用）', '已注册到 web profile。',
    '[3/4] 构建浏览器扩展', '1. 开启“开发者模式”', '2. 点击“加载已解压的扩展程序”', 'DSH 注册结果：', '• web profile：已注册',
    '加载完成后：', '• 打开 DeepSeek Harness（如果它正在运行，请重启）', '• 点击工具栏中的 DeepSeek 鲸鱼图标，打开侧边栏']) {
    assert.equal(lines.includes(line), true, `${line}\n${result.stdout}`)
  }
  assert.match(result.stdout, /^• DeepSeek Harness 桌面应用：已注册（.*DeepSeek Harness\.app）$/m)
  // Every message is one line in both runs, with the same indent, bullet or number.
  const shape = text => text.split('\n').map(line => /^(\s*(?:• |\d\. |\[\d\/4\] )?)/.exec(line)[1])
  assert.deepEqual(shape(result.stdout), shape(english.stdout))
  assert.doesNotMatch(result.stdout, /• •|\d\. \d\. /)
})

test('language: the locale selects it when DSH_BROWSER_LANG is not set, and the override wins', { skip }, async (t) => {
  // A failing first step, so each run is short and shows the error path as well.
  const firstStep = async (env) => {
    const result = await stubCheckout(sandbox(t), { pnpm: FAILING_PNPM }, { env: { ...LOCALE, ...env } })
    assert.equal(result.status, 3, result.stdout + result.stderr)
    return result
  }
  for (const env of [{ LANG: 'zh_CN.UTF-8' }, { LANG: 'ZH_tw' }, { LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' },
    { LC_ALL: 'zh_HK.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    { DSH_BROWSER_LANG: 'zh', LANG: 'en_US.UTF-8' }, { DSH_BROWSER_LANG: 'ZH', LC_ALL: 'C' }]) {
    const result = await firstStep(env)
    assert.match(result.stdout, /^\[1\/4\] 构建浏览器桥$/m, JSON.stringify(env))
    assert.match(result.stderr, /^完整输出：.*dsh-browser-install\.\w+$/m)
    assert.match(result.stderr, /^错误：依赖安装失败（退出码 3）。$/m)
    assertNoEnglish(result.stdout + result.stderr)
  }
  for (const env of [{ LANG: 'en_US.UTF-8' }, { LANG: 'fr_FR.UTF-8' }, { LC_ALL: 'en_GB.UTF-8', LANG: 'zh_CN.UTF-8' },
    { LC_MESSAGES: 'de_DE.UTF-8', LANG: 'zh_CN.UTF-8' }, { DSH_BROWSER_LANG: 'en', LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' },
    // On macOS an unset or C locale falls back to the system language list, which a test cannot stage.
    ...(process.platform === 'darwin' ? [] : [{}, { LC_ALL: 'C', LANG: 'zh_CN.UTF-8' }, { LANG: 'POSIX' }])]) {
    const result = await firstStep(env)
    assert.match(result.stdout, /^\[1\/4\] Build the browser bridge$/m, JSON.stringify(env))
    assert.match(result.stderr, /^Full output: .*dsh-browser-install\.\w+$/m)
    assert.match(result.stderr, /^Error: Installing dependencies failed \(exit code 3\)\.$/m)
    assert.doesNotMatch(result.stdout + result.stderr, CJK, JSON.stringify(env))
  }
})

test('language: stops and warnings are in one language too', { skip }, async (t) => {
  const oldNode = env => stubCheckout(sandbox(t), { node: OLD_NODE, pnpm: RECORDING, asdf: 'exit 0' }, { env })
  const english = await oldNode({})
  assert.equal(english.status, 1, english.stdout + english.stderr)
  assert.doesNotMatch(english.stdout + english.stderr, CJK)
  const chinese = await oldNode({ DSH_BROWSER_LANG: 'zh' })
  assert.equal(chinese.status, 1, chinese.stdout + chinese.stderr)
  assert.match(chinese.stderr, /^错误：需要 Node\.js 24\.9\.0 或更新版本；PATH 上的 node 是 18\.19\.0（.*\/bin\/node）。$/m)
  assert.match(chinese.stderr, /^请用下面任一命令安装，然后重新运行本安装脚本：$/m)
  assert.match(chinese.stderr, /asdf: {3}asdf plugin add nodejs/)
  assertNoEnglish(chinese.stdout + chinese.stderr)

  const desktopRun = (cli, env = {}) => {
    const box = sandbox(t)
    const desktop = desktopApp(box, { cli })
    return stubCheckout(box, { pnpm: WORKING_PNPM }, { complete: true, env: { ...desktop.env, ...env } })
  }
  const failed = await desktopRun('fail', { DSH_BROWSER_LANG: 'zh' })
  assert.equal(failed.status, 1, failed.stdout + failed.stderr)
  assert.match(failed.stderr, /^警告：注册到 DeepSeek Harness 桌面应用失败。安装会继续完成其余步骤。$/m)
  assert.match(failed.stderr, /^ {3}退出码：5$/m)
  assert.match(failed.stdout, /^• DeepSeek Harness 桌面应用：未注册。警告：/m)
  assertNoEnglish(failed.stdout + failed.stderr)
  for (const cli of ['fail', 'reject']) {
    const warned = await desktopRun(cli)
    assert.match(warned.stderr, /^WARNING: /m)
    assert.match(warned.stderr, /^ {3}exit code: [15]$/m)
    assert.doesNotMatch(warned.stdout + warned.stderr, CJK)
  }
})

test('language: --lang selects it, reaches the usage text, and accepts only en and zh', { skip }, async (t) => {
  const box = sandbox(t)
  const usage = (args, env = {}) => run('bash', [installer, ...args], { env: { ...box.env, ...env }, cwd: box.base })
  const chinese = await usage(['--lang', 'zh', '--help'])
  assert.equal(chinese.status, 0, chinese.stderr)
  assert.match(chinese.stdout, /^用法：install\.sh /)
  assert.doesNotMatch(chinese.stdout, /Usage|download that tagged release/)
  for (const result of [await usage(['--help']), await usage(['--lang=en', '--help'], { DSH_BROWSER_LANG: 'zh' })]) {
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^Usage: install\.sh .*\[--lang en\|zh\]/)
    assert.doesNotMatch(result.stdout, CJK)
  }
  const unknown = await usage(['--lang', 'fr'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /^Error: --lang accepts en or zh: fr$/m)
  assert.doesNotMatch(unknown.stdout + unknown.stderr, CJK)
  const missing = await usage(['--lang'], { DSH_BROWSER_LANG: 'zh' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /^错误：--lang 需要一个值。$/m)
})

test('language: on macOS without a locale, the first system language decides, and failing to read it means English', { skip }, async (t) => {
  // A stand-in for macOS: uname says Darwin and `defaults read -g AppleLanguages` prints the given list.
  const usage = (defaults, env = {}) => {
    const box = sandbox(t)
    const bin = join(box.base, 'bin')
    executable(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n')
    executable(join(bin, 'defaults'), `#!/bin/sh\n[ "$*" = "read -g AppleLanguages" ] || exit 64\n${defaults}\n`)
    return run('bash', [installer, '--help'], {
      env: { ...box.env, ...LOCALE, PATH: `${bin}${delimiter}${process.env.PATH}`, ...env }, cwd: box.base,
    })
  }
  const list = (...tags) => `printf '(\\n${tags.map(tag => `    "${tag}"`).join(',\\n')}\\n)\\n'`
  for (const [defaults, env] of [[list('zh-Hans-CN', 'en-CN')], [list('zh-Hant-TW')], [list('zh-Hans-CN'), { LC_ALL: 'C' }],
    [list('zh-Hans-CN'), { LANG: 'C.UTF-8' }]]) {
    const result = await usage(defaults, env)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^用法：install\.sh /, defaults)
  }
  for (const [defaults, env] of [[list('en-US', 'zh-Hans-US')], [list('ja-JP')], ['exit 1'], ['echo "(" ; exit 1'], ['exit 0'],
    [list('zh-Hans-CN'), { LANG: 'en_US.UTF-8' }], [list('zh-Hans-CN'), { DSH_BROWSER_LANG: 'en' }]]) {
    const result = await usage(defaults, env)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^Usage: install\.sh /, defaults)
    assert.equal(result.stderr, '')
  }
})

test('language: the release download of install.sh and uninstall.sh follows it', { skip }, async (t) => {
  const box = sandbox(t)
  const server = await serve(t, { releases: { 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9' })
  const english = await pipedInstall(box, server)
  assert.equal(english.status, 0, english.stdout + english.stderr)
  assert.doesNotMatch(english.stdout + english.stderr, CJK)
  const chinese = await pipedInstall(box, server, ['--lang', 'zh'])
  assert.equal(chinese.status, 0, chinese.stdout + chinese.stderr)
  assert.match(chinese.stdout, /^已校验：v9\.9\.9 的 1 个文件与 SHA256SUMS 一致。$/m)
  assert.match(chinese.stdout, /^安装文件已同步到 .*dsh-browser（发布版本 v9\.9\.9，已通过 SHA256SUMS 校验）。$/m)
  assertNoEnglish(chinese.stdout + chinese.stderr)
  assert.doesNotMatch(chinese.stdout, /Downloading release|Installation files are ready/)
  // The marker file is data, not a message: it reads the same in both languages.
  assert.equal(readFileSync(join(box.managed, '.managed-by-install-sh'), 'utf8'), 'release v9.9.9 (SHA256SUMS verified)\n')

  // uninstall.sh keeps --lang to itself; the uninstall.mjs it runs gets the choice from the environment.
  const removedEnglish = await pipedUninstall(box, server, ['--dry-run'])
  assert.equal(removedEnglish.status, 0, removedEnglish.stdout + removedEnglish.stderr)
  assert.match(removedEnglish.stdout, /^Verified: 1 file\(s\) of v9\.9\.9 match SHA256SUMS\.$/m)
  assert.doesNotMatch(removedEnglish.stdout + removedEnglish.stderr, CJK)
  for (const args of [['--lang', 'zh', '--dry-run'], ['--dry-run', '--lang=zh']]) {
    const removed = await pipedUninstall(box, server, args)
    assert.equal(removed.status, 0, removed.stdout + removed.stderr)
    assert.match(removed.stdout, /^已校验：v9\.9\.9 的 1 个文件与 SHA256SUMS 一致。$/m)
    assertNoEnglish(removed.stdout + removed.stderr)
  }
  assert.deepEqual(ranLines(box).filter(line => line.startsWith('uninstall ')), Array(3).fill('uninstall v9.9.9 --dry-run'))
  const unknown = await pipedUninstall(box, server, ['--lang', 'de'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /^Error: --lang accepts en or zh: de$/m)

  const tamperedBox = sandbox(t)
  const release = stubRelease(tamperedBox.base, 'v9.9.8')
  appendFileSync(join(release, assetNames('v9.9.8').sourceTar), 'tampered')
  const tampered = await serve(t, { releases: { 'v9.9.8': release }, latest: 'v9.9.8' })
  const refusedEnglish = await pipedInstall(tamperedBox, tampered)
  assert.equal(refusedEnglish.status, 1)
  assert.match(refusedEnglish.stderr, /^Error: SHA-256 mismatch for /m)
  assert.doesNotMatch(refusedEnglish.stdout + refusedEnglish.stderr, CJK)
  const refusedChinese = await pipedInstall(tamperedBox, tampered, [], { DSH_BROWSER_LANG: 'zh' })
  assert.equal(refusedChinese.status, 1)
  assert.match(refusedChinese.stderr, /^错误：dsh-browser-source-v9\.9\.8\.tar\.gz 的 SHA-256 与 SHA256SUMS 不符/m)
  assertNoEnglish(refusedChinese.stdout + refusedChinese.stderr)
  assert.deepEqual(ranLines(tamperedBox), [])
})

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The real installer assets of this working tree, as scripts/package-release.mjs writes them. */
function realRelease(base, tag) {
  const dir = join(base, `real-${tag}`)
  mkdirSync(dir, { recursive: true })
  writeChecksums(writeInstallerAssets(root, dir, tag), join(dir, 'SHA256SUMS'))
  return dir
}

test('real artifacts: the packaged source archive verifies and unpacks to this working tree', { skip }, async (t) => {
  const box = sandbox(t)
  const tag = `v${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`
  const release = realRelease(box.base, tag)
  assert.deepEqual(readdirSync(release).sort(), [
    'SHA256SUMS', `dsh-browser-source-${tag}.tar.gz`, `dsh-browser-source-${tag}.zip`,
    'install.ps1', 'install.sh', 'uninstall.mjs', 'uninstall.ps1', 'uninstall.sh',
  ])
  const check = await run('sha256sum', ['-c', 'SHA256SUMS'], { cwd: release, env: box.env }).catch(() => null)
  if (check) assert.equal(check.status, 0, check.stdout + check.stderr)

  // The second stage is the real installer; a failing pnpm stops it at the build.
  const bin = join(box.base, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\n[ "$1" = --version ] && exit 0\nexit 3\n')
  chmodSync(join(bin, 'pnpm'), 0o755)
  const server = await serve(t, { releases: { [tag]: release }, latest: tag })
  const result = await pipedInstall(box, server, [], { PATH: `${bin}${delimiter}${process.env.PATH}` })
  assert.equal(result.status, 3, result.stdout + result.stderr)
  assert.match(result.stdout, /\[1\/4\]/, 'the unpacked installer started')
  for (const name of ['scripts/install.sh', 'scripts/uninstall.mjs', 'package.json', 'pnpm-lock.yaml',
    'extensions/dsh-browser/manifest.json', 'packages/browser/bridge-browser/package.json']) {
    assert.equal(sha256(join(box.managed, name)), sha256(join(root, name)), name)
  }
  assert.equal(existsSync(join(box.managed, 'node_modules')), false)
})

test('real artifacts: a tampered source archive must fail', { skip }, async (t) => {
  const box = sandbox(t)
  const tag = `v${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`
  const release = realRelease(box.base, tag)
  const archive = join(release, assetNames(tag).sourceTar)
  const bytes = readFileSync(archive)
  bytes[Math.floor(bytes.length / 2)] ^= 0xff
  writeFileSync(archive, bytes)
  const server = await serve(t, { releases: { [tag]: release }, latest: tag })
  refused(box, await pipedInstall(box, server), /SHA-256 mismatch/)
})

// The local dry run of a release: package the real installer assets, serve them, and let the
// installer download, verify, build and register into a throwaway DSH home. It runs
// `pnpm install` and both builds, so it is opt-in: DSH_RELEASE_E2E=1 pnpm test:release-dry-run
test('dry run: the real release installs end to end into a temporary DSH home', {
  skip: skip || (process.env.DSH_RELEASE_E2E === '1' ? false : 'set DSH_RELEASE_E2E=1 (pnpm test:release-dry-run)'),
  timeout: 900_000,
}, async (t) => {
  const box = sandbox(t)
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const tag = `v${version}`
  const server = await serve(t, { releases: { [tag]: realRelease(box.base, tag) }, latest: tag })
  const result = await run('bash', ['-s'], {
    env: { ...box.env, DSH_BROWSER_GITHUB_URL: server.url }, cwd: box.base, input: readFileSync(installer), timeout: 850_000,
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, new RegExp(`Verified: 1 file\\(s\\) of ${tag.replaceAll('.', '\\.')} match SHA256SUMS`))
  const extension = join(box.dshHome, 'browser-extension')
  assert.equal(JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version, version)
  assert.equal(JSON.parse(readFileSync(join(extension, 'install-info.json'), 'utf8')).mode, 'managed')
  assert.equal(existsSync(join(extension, 'bridge-token')), true)
  const profile = JSON.parse(readFileSync(join(box.dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.ok(Object.hasOwn(profile.dependencies ?? {}, 'dsh-browser-agent'), JSON.stringify(profile))

  // The uninstaller that release shipped removes it again, old-scope cleanup included.
  const removed = await run('bash', [join(box.managed, 'scripts', 'uninstall.sh'), '--home', box.dshHome], {
    env: box.env, cwd: box.base, timeout: 300_000,
  })
  assert.equal(removed.status, 0, removed.stdout + removed.stderr)
  assert.equal(existsSync(extension), false)
  assert.equal(existsSync(box.managed), false)
})
