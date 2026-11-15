// The release path of scripts/install.sh and scripts/uninstall.sh against a local stand-in
// for GitHub Releases (scripts/lib/local-release.mjs): a tagged release is downloaded,
// checked against its SHA256SUMS, and only then unpacked or run.
//
// Most cases use a stub release whose payload only records that it ran, so "nothing ran"
// is observable. Two use the real artifacts from scripts/package-release.mjs; the full
// build-and-register dry run is the last test and runs only with DSH_RELEASE_E2E=1
// (see RELEASING.md).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
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
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', DSH_BROWSER_NO_LAUNCH: '1' }
  for (const name of Object.keys(env)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|DSH_BROWSER_(?!NO_LAUNCH).*)$/.test(name)) delete env[name]
  }
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
  writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\nexit 3\n')
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
  writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\nexit 3\n')
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
  assert.ok(Object.hasOwn(profile.dependencies ?? {}, '@natgurlain/dsh-bridge-browser'), JSON.stringify(profile))

  // The uninstaller that release shipped removes it again, old-scope cleanup included.
  const removed = await run('bash', [join(box.managed, 'scripts', 'uninstall.sh'), '--home', box.dshHome], {
    env: box.env, cwd: box.base, timeout: 300_000,
  })
  assert.equal(removed.status, 0, removed.stdout + removed.stderr)
  assert.equal(existsSync(extension), false)
  assert.equal(existsSync(box.managed), false)
})
