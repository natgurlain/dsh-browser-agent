// scripts/install.ps1, run for real: by Windows PowerShell 5.1 (powershell.exe, what the
// documented commands use) and, with TEST_PWSH=1, by PowerShell 7 (pwsh). The script refuses
// to run anywhere but Windows, so every test here is skipped on other platforms.
//
// Like release-install.test.mjs for install.sh, the release path runs against a local
// stand-in for GitHub Releases (scripts/lib/local-release.mjs). Most cases use a stub
// release whose second-stage install.ps1 only records that it ran, so "nothing ran" is
// observable. The last one installs the real release of this working tree end to end into a
// throwaway DSH home and uninstalls it again; it runs `pnpm install` and both builds, so it
// needs DSH_RELEASE_E2E=1 (the Script tests workflow sets it).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { run, serveReleases } from '../lib/local-release.mjs'
import { assetNames, createZip, writeChecksums, writeInstallerAssets } from '../package-release.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const installer = join(root, 'scripts', 'install.ps1')
const skip = process.platform === 'win32' ? false : 'install.ps1 runs on Windows only'
const shells = ['powershell.exe', ...(process.env.TEST_PWSH === '1' ? ['pwsh'] : [])]
const TOKEN = 'ghp_localReleaseTestToken0123456789'
// Han characters, CJK punctuation and the full-width forms the Chinese messages use.
const CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯]/u
const BRIDGE = '@natgurlain/dsh-bridge-browser'

/**
 * A private sandbox: DSH_HOME, TEMP, a standalone copy of install.ps1 (outside any checkout,
 * the way a downloaded one is), and an environment with no GitHub credentials.
 */
function sandbox(t, homeName = 'home 空间 & user') {
  // RUNNER_TEMP is on the drive of the checkout, where the pnpm store already is.
  const base = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'dsh-ps-'))
  t.after(() => {
    // Best effort: a file Windows still holds open must not fail the test that passed.
    try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { }
  })
  const dshHome = join(base, homeName, '.dsh')
  const temporary = join(base, 'tmp')
  const ghConfig = join(base, 'gh-config')
  for (const dir of [dirname(dshHome), temporary, ghConfig]) mkdirSync(dir, { recursive: true })
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|DSH_BROWSER_.*|DSH_INSTALL_BROWSER|DSH_HOME|TEMP|TMP|NO_PROXY)$/i.test(name)) delete env[name]
  }
  Object.assign(env, {
    DSH_HOME: dshHome, TEMP: temporary, TMP: temporary, GH_CONFIG_DIR: ghConfig, NO_PROXY: '127.0.0.1,localhost',
    // Never open Chrome or touch the clipboard; one language per run, English unless a test says otherwise.
    DSH_BROWSER_NO_LAUNCH: '1', DSH_BROWSER_LANG: 'en',
  })
  const script = join(base, 'install.ps1')
  copyFileSync(installer, script)
  return { base, dshHome, temporary, env, script, managed: join(dshHome, 'dsh-browser'), ran: join(base, 'payload-ran') }
}

/**
 * A release whose source archive is a minimal workspace: its scripts/install.ps1 (the second
 * stage the real installer hands over to) only appends a line to $env:STUB_RAN.
 */
function stubRelease(base, tag, extra = {}) {
  const dir = join(base, `release-${tag}`)
  mkdirSync(dir, { recursive: true })
  const file = (name, text) => ({ name: `dsh-browser-${tag}/${name}`, data: Buffer.from(text) })
  const archive = join(dir, assetNames(tag).sourceZip)
  writeFileSync(archive, createZip([
    file('package.json', JSON.stringify({ name: 'dsh-browser', version: tag.slice(1) })),
    file('pnpm-lock.yaml', ''),
    file('extensions/dsh-browser/package.json', '{}'),
    file('packages/browser/bridge-browser/package.json', '{}'),
    file('scripts/install.ps1',
      `Add-Content -LiteralPath $env:STUB_RAN -Encoding ASCII -Value ("install ${tag} bootstrapped={0} args={1}" -f $env:DSH_BROWSER_BOOTSTRAPPED, ($args -join ' '))\n`),
    ...Object.entries(extra).map(([name, text]) => file(name, text)),
  ], { mtime: 1_700_000_000 }))
  writeChecksums([archive], join(dir, 'SHA256SUMS'))
  return dir
}

async function serve(t, options) {
  const server = await serveReleases(options)
  t.after(() => server.close())
  return server
}

/** Run a PowerShell script file the way the documented commands do. */
function powershell(shell, script, args, { env, cwd, timeout = 120_000 }) {
  return run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { env, cwd, timeout })
}

function install(shell, box, server, args = [], extraEnv = {}, timeout) {
  return powershell(shell, box.script, args, {
    env: { ...box.env, DSH_BROWSER_GITHUB_URL: server.url, DSH_BROWSER_GITHUB_API_URL: server.apiUrl, STUB_RAN: box.ran, ...extraEnv },
    cwd: box.base, timeout,
  })
}

function ranLines(box) {
  return existsSync(box.ran) ? readFileSync(box.ran, 'utf8').trim().split(/\r?\n/) : []
}

/** Both streams with the sandbox paths (which have Chinese in them on purpose) replaced. */
function messages(box, result) {
  return [dirname(box.dshHome), box.base].flatMap(path => [path, path.replaceAll('\\', '/')])
    .reduce((text, path) => text.replaceAll(path, '<path>'), result.stdout + result.stderr)
}

function leftovers(box) {
  return readdirSync(box.temporary).filter(name => name.startsWith('dsh-browser-install-'))
}

function refused(box, result, pattern) {
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, pattern)
  assert.deepEqual(ranLines(box), [], 'no part of the download may run')
  assert.equal(existsSync(box.managed), false, 'nothing may be unpacked into the managed root')
  assert.deepEqual(leftovers(box), [], 'the download directory is removed')
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

for (const shell of shells) {
  test(`${shell}: the latest release is verified, unpacked into the managed root and its installer run; an update replaces it`, { skip }, async (t) => {
    const box = sandbox(t)
    const server = await serve(t, {
      releases: {
        'v9.9.8': stubRelease(box.base, 'v9.9.8', { 'only-in-9.9.8.txt': 'old', 'docs/old/page.md': 'old' }),
        'v9.9.9': stubRelease(box.base, 'v9.9.9'),
      },
      latest: 'v9.9.8',
    })
    // No option outside a checkout: the latest release.
    const first = await install(shell, box, server)
    assert.equal(first.status, 0, first.stdout + first.stderr)
    assert.match(first.stdout, /^No complete local checkout was detected; switching to the clone-free install\.$/m)
    assert.match(first.stdout, /^Downloading release latest of natgurlain\/dsh-browser-agent and verifying it…$/m)
    assert.match(first.stdout, /^Verified: 1 file\(s\) of v9\.9\.8 match SHA256SUMS\.$/m)
    assert.match(first.stdout, /^Installation files are ready in .*dsh-browser \(release v9\.9\.8 \(SHA256SUMS verified\)\)\.$/m)
    assert.doesNotMatch(messages(box, first), CJK, 'an English run prints no Chinese')
    assert.deepEqual(ranLines(box), ['install v9.9.8 bootstrapped=1 args='])
    assert.equal(readFileSync(join(box.managed, '.managed-by-install-sh'), 'utf8'), 'release v9.9.8 (SHA256SUMS verified)\n')
    assert.equal(readFileSync(join(box.managed, 'only-in-9.9.8.txt'), 'utf8'), 'old')
    assert.deepEqual(leftovers(box), [])
    assert.deepEqual(server.paths().slice(0, 3), ['releases/latest', 'releases/tag/v9.9.8', 'releases/download/v9.9.8/SHA256SUMS'])

    // An update to a pinned release (a bare version number is accepted): files the new release
    // no longer has are removed, node_modules survives.
    mkdirSync(join(box.managed, 'node_modules', 'kept'), { recursive: true })
    writeFileSync(join(box.managed, 'node_modules', 'kept', 'index.js'), 'kept\n')
    const second = await install(shell, box, server, ['--release', '9.9.9'])
    assert.equal(second.status, 0, second.stdout + second.stderr)
    assert.match(second.stdout, /^Verified: 1 file\(s\) of v9\.9\.9 match SHA256SUMS\.$/m)
    assert.deepEqual(ranLines(box), ['install v9.9.8 bootstrapped=1 args=', 'install v9.9.9 bootstrapped=1 args='])
    assert.equal(JSON.parse(readFileSync(join(box.managed, 'package.json'), 'utf8')).version, '9.9.9')
    assert.equal(existsSync(join(box.managed, 'only-in-9.9.8.txt')), false)
    assert.equal(existsSync(join(box.managed, 'docs')), false)
    assert.equal(readFileSync(join(box.managed, 'node_modules', 'kept', 'index.js'), 'utf8'), 'kept\n')
    assert.equal(readFileSync(join(box.managed, '.managed-by-install-sh'), 'utf8'), 'release v9.9.9 (SHA256SUMS verified)\n')

    // The same run in Chinese prints no English sentence.
    const chinese = await install(shell, box, server, ['--release=v9.9.9', '--lang', 'zh'])
    assert.equal(chinese.status, 0, chinese.stdout + chinese.stderr)
    assert.match(chinese.stdout, /^已校验：v9\.9\.9 的 1 个文件与 SHA256SUMS 一致。$/m)
    for (const sentence of ['Downloading release', 'Verified:', 'Installation files are ready']) {
      assert.equal(chinese.stdout.includes(sentence), false, chinese.stdout)
    }
  })

  test(`${shell}: a tampered archive, a missing SHA256SUMS or an unknown tag is refused before anything is unpacked`, { skip }, async (t) => {
    const box = sandbox(t)
    const tampered = stubRelease(box.base, 'v9.9.9')
    appendFileSync(join(tampered, assetNames('v9.9.9').sourceZip), 'tampered')
    const unsigned = stubRelease(box.base, 'v9.9.7')
    rmSync(join(unsigned, 'SHA256SUMS'))
    const server = await serve(t, { releases: { 'v9.9.9': tampered, 'v9.9.7': unsigned }, latest: 'v9.9.9' })

    const english = await install(shell, box, server)
    refused(box, english, /^Error: SHA-256 mismatch for dsh-browser-source-v9\.9\.9\.zip \(expected [0-9a-f]{64}, got [0-9a-f]{64}\)\. Nothing was unpacked or run\.$/m)
    assert.doesNotMatch(messages(box, english), CJK)
    const chinese = await install(shell, box, server, [], { DSH_BROWSER_LANG: 'zh' })
    refused(box, chinese, /^错误：dsh-browser-source-v9\.9\.9\.zip 的 SHA-256 与 SHA256SUMS 不符/m)
    assert.equal(chinese.stderr.includes('SHA-256 mismatch'), false, chinese.stderr)

    refused(box, await install(shell, box, server, ['--release', 'v9.9.7']), /^Error: Release v9\.9\.7 has no SHA256SUMS, so nothing can be verified; stopping\.$/m)
    refused(box, await install(shell, box, server, ['--release', 'v1.2.3']), /^Error: Release v1\.2\.3 of natgurlain\/dsh-browser-agent is not reachable anonymously/m)
    refused(box, await install(shell, box, server, ['--release', 'main']), /^Error: Not a release tag: main/m)
    refused(box, await install(shell, box, server, [], { DSH_BROWSER_GITHUB_URL: 'http://example.invalid' }), /^Error: Download URLs must use HTTPS/m)

    // A managed root that is somebody else's directory is left alone.
    mkdirSync(box.managed, { recursive: true })
    writeFileSync(join(box.managed, 'mine.txt'), 'mine')
    const foreign = await install(shell, box, server)
    assert.equal(foreign.status, 1, foreign.stdout + foreign.stderr)
    assert.match(foreign.stderr, /^Error: .*dsh-browser already exists and is not managed by this installer/m)
    assert.deepEqual(readdirSync(box.managed), ['mine.txt'])
  })

  test(`${shell}: usage, --lang and option errors`, { skip }, async (t) => {
    const box = sandbox(t)
    const server = await serve(t, { releases: {} })
    const help = await install(shell, box, server, ['--help'])
    assert.equal(help.status, 0, help.stdout + help.stderr)
    assert.match(help.stdout, /^Usage: install\.ps1 \[--release latest\|vX\.Y\.Z\]/m)
    assert.doesNotMatch(help.stdout, CJK)
    for (const args of [['--lang', 'zh', '--help'], ['--lang=ZH', '--help']]) {
      const chinese = await install(shell, box, server, args)
      assert.equal(chinese.status, 0, chinese.stdout + chinese.stderr)
      assert.match(chinese.stdout, /^用法：install\.ps1 /m)
      assert.equal(chinese.stdout.includes('Usage:'), false)
    }
    const fromEnv = await install(shell, box, server, ['--help'], { DSH_BROWSER_LANG: 'zh' })
    assert.match(fromEnv.stdout, /^用法：install\.ps1 /m)
    const overridden = await install(shell, box, server, ['--lang', 'en', '--help'], { DSH_BROWSER_LANG: 'zh' })
    assert.equal(overridden.stdout, help.stdout)

    for (const [args, pattern] of [
      [['--bogus'], /^Error: Unknown option: --bogus$/m],
      [['--lang', 'fr'], /^Error: --lang accepts en or zh: fr$/m],
      [['--release'], /^Error: --release needs a value\.$/m],
      [['--release', 'v1.0.0', '--unverified-branch', 'main'], /^Error: --release and --unverified-branch cannot be combined\.$/m],
    ]) {
      const result = await install(shell, box, server, args)
      assert.equal(result.status, 1, JSON.stringify(args) + result.stdout + result.stderr)
      assert.match(result.stderr, pattern)
      assert.doesNotMatch(result.stdout + result.stderr, CJK)
    }
    assert.deepEqual(server.paths(), [], 'nothing was requested')
    assert.equal(existsSync(box.managed), false)
  })

  test(`${shell}: private repository — instructions without credentials, a verified API download with a token`, { skip }, async (t) => {
    const box = sandbox(t)
    const server = await serve(t, { releases: { 'v9.9.9': stubRelease(box.base, 'v9.9.9') }, latest: 'v9.9.9', private: true, token: TOKEN })
    refused(box, await install(shell, box, server), /^Error: Release latest of natgurlain\/dsh-browser-agent is not reachable anonymously: the repository is private/m)
    refused(box, await install(shell, box, server, [], { DSH_BROWSER_GITHUB_TOKEN: 'ghp_wrong' }), /^Error: GitHub rejected DSH_BROWSER_GITHUB_TOKEN \(HTTP 401\)\.$/m)

    const result = await install(shell, box, server, [], { DSH_BROWSER_GITHUB_TOKEN: TOKEN })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /^Verified: 1 file\(s\) of v9\.9\.9 match SHA256SUMS\.$/m)
    assert.deepEqual(ranLines(box), ['install v9.9.9 bootstrapped=1 args='])
    assert.equal((result.stdout + result.stderr).includes(TOKEN), false, 'the token is never printed')
    for (const request of server.requests) {
      if (!request.url.startsWith('/api/')) assert.equal(request.authorization, undefined, `${request.url} must not carry the token`)
    }
  })
}

// The Windows counterpart of the "dry run" in release-install.test.mjs: package the real
// installer assets of this working tree, serve them, and let Windows PowerShell download,
// verify, build and register into a throwaway DSH home; then update it with the command the
// panel shows, and remove it with the uninstall.ps1 that release shipped.
test('dry run on Windows: the real release installs, updates and uninstalls end to end in a temporary DSH home', {
  skip: skip || (process.env.DSH_RELEASE_E2E === '1' ? false : 'set DSH_RELEASE_E2E=1'),
  timeout: 1_200_000,
}, async (t) => {
  const shell = 'powershell.exe'
  const box = sandbox(t, 'dsh home')
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const tag = `v${version}`
  const release = join(box.base, `real-${tag}`)
  mkdirSync(release)
  writeChecksums(writeInstallerAssets(root, release, tag), join(release, 'SHA256SUMS'))
  const server = await serve(t, { releases: { [tag]: release }, latest: tag })
  // The documented form: the release's own install.ps1, downloaded, then run with the tag.
  copyFileSync(join(release, 'install.ps1'), box.script)
  const log = (name, result) => writeFileSync(join(box.base, `${name}.log`), result.stdout + result.stderr)

  const result = await install(shell, box, server, ['--release', tag], {}, 800_000)
  log('install', result)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, new RegExp(`^Verified: 1 file\\(s\\) of ${tag.replaceAll('.', '\\.')} match SHA256SUMS\\.$`, 'm'))
  for (const step of ['[1/4] Build the browser bridge', '[2/4] Register with DSH (web profile)', '[3/4] Build the Chrome extension',
    '[4/4] Prepare the extension and open Chrome', '• web profile: registered']) {
    assert.equal(result.stdout.split(/\r?\n/).includes(step), true, `${step}\n${result.stdout}`)
  }
  assert.doesNotMatch(result.stdout + result.stderr, CJK, 'an English run prints no Chinese')
  assert.doesNotMatch(result.stdout, /Warning:/)
  // The unpacked source is byte for byte the working tree.
  for (const name of ['scripts/install.ps1', 'scripts/uninstall.ps1', 'scripts/uninstall.mjs', 'package.json', 'pnpm-lock.yaml',
    'extensions/dsh-browser/manifest.json', 'packages/browser/bridge-browser/package.json']) {
    assert.equal(sha256(join(box.managed, name)), sha256(join(root, name)), name)
  }
  const extension = join(box.dshHome, 'browser-extension')
  assert.equal(JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version, version)
  const info = JSON.parse(readFileSync(join(extension, 'install-info.json'), 'utf8'))
  assert.equal(info.mode, 'managed')
  const token = readFileSync(join(extension, 'bridge-token'), 'utf8')
  assert.equal(token, readFileSync(join(box.dshHome, 'ext-bridge-token'), 'utf8'))
  const profile = () => JSON.parse(readFileSync(join(box.dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.ok(Object.hasOwn(profile().dependencies ?? {}, BRIDGE), JSON.stringify(profile()))
  assert.ok(profile().dsh.profile.bundles.includes(BRIDGE), JSON.stringify(profile()))

  // The update the panel offers for a managed install: the installed installer, with --release.
  const update = await powershell(shell, join(box.managed, 'scripts', 'install.ps1'), ['--release', tag],
    { env: { ...box.env, DSH_BROWSER_GITHUB_URL: server.url }, cwd: box.base, timeout: 800_000 })
  log('update', update)
  assert.equal(update.status, 0, update.stdout + update.stderr)
  assert.match(update.stdout, /^Existing extension directory detected; its files were updated safely\.$/m)
  assert.equal(readFileSync(join(extension, 'bridge-token'), 'utf8'), token, 'an update keeps the bridge token')
  assert.ok(Object.hasOwn(profile().dependencies ?? {}, BRIDGE), JSON.stringify(profile()))
  assert.equal(profile().dsh.profile.bundles.filter(name => name === BRIDGE).length, 1)

  const removed = await powershell(shell, join(box.managed, 'scripts', 'uninstall.ps1'), ['--home', box.dshHome],
    { env: box.env, cwd: box.base, timeout: 300_000 })
  log('uninstall', removed)
  assert.equal(removed.status, 0, removed.stdout + removed.stderr)
  assert.equal(existsSync(extension), false)
  assert.equal(existsSync(box.managed), false)
  assert.equal(Object.hasOwn(profile().dependencies ?? {}, BRIDGE), false, JSON.stringify(profile()))
})
