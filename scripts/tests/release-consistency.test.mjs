// One release, one set of names: the version files, the tag the docs pin, the changelog,
// the asset names the installers build, and the two copies of each release-fetch block
// must agree, and nothing a user is told to run may follow a branch.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  releaseAssetUrl, releaseInstallCommand, windowsReleaseInstallCommand,
} from '../../extensions/dsh-browser/src/panel/updates.ts'
import { uninstallCommand } from '../../extensions/dsh-browser/src/panel/uninstall.ts'
import { assetNames, BOOTSTRAP_SCRIPTS, changelogSection, releaseNotes } from '../package-release.mjs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const json = (path) => JSON.parse(read(path))
const version = json('package.json').version
const tag = `v${version}`

function fetchBlock(path) {
  const match = /^# >>> release-fetch\n([\s\S]*?)^# <<< release-fetch$/mu.exec(read(path))
  assert.ok(match, `${path} has a release-fetch block`)
  return match[1]
}

test('root, extension package and both manifests carry the same version', () => {
  for (const path of ['extensions/dsh-browser/package.json', 'extensions/dsh-browser/manifest.json',
    'extensions/dsh-browser/manifest.firefox.json']) {
    assert.equal(json(path).version, version, path)
  }
  assert.match(version, /^\d+\.\d+\.\d+$/)
})

test('CHANGELOG.md has the section this version publishes as release notes', () => {
  const section = changelogSection(read('CHANGELOG.md'), tag)
  assert.ok(section.length > 200, 'the section has content')
  const notes = releaseNotes(read('CHANGELOG.md'), tag, [`${'a'.repeat(64)}  install.sh`])
  assert.ok(notes.startsWith(section))
  assert.match(notes, /## SHA-256\n[\s\S]*\n```\na{64} {2}install\.sh\n```\n$/)
  assert.throws(() => changelogSection(read('CHANGELOG.md'), 'v0.0.0'), /no "## v0\.0\.0" section/)
})

test('the README commands name this release and match the commands the panel shows', () => {
  for (const path of ['README.md', 'README.zh.md']) {
    const text = read(path)
    assert.equal(text.includes(releaseInstallCommand(tag)), true, `${path}: pinned install one-liner`)
    assert.equal(text.includes(uninstallCommand({ mode: 'unknown' }, 'Linux', version)), true, `${path}: uninstall`)
    assert.equal(text.includes(uninstallCommand({ mode: 'unknown' }, 'Windows', version)), true, `${path}: Windows uninstall`)
    assert.equal(text.includes(`tag=${tag}\n`), true, `${path}: two-step form`)
    assert.equal(text.includes(`$tag = '${tag}'\n`), true, `${path}: Windows two-step form`)
    const pinned = [...text.matchAll(/releases\/download\/(v[0-9][^/"\s]*)\//gu)].map(match => match[1])
    assert.ok(pinned.length >= 3, path)
    assert.deepEqual([...new Set(pinned)], [tag], `${path}: every pinned download names ${tag}`)
  }
  assert.equal(windowsReleaseInstallCommand(tag).includes(releaseAssetUrl(tag, 'install.ps1')), true)
})

test('nothing a user runs follows a branch', () => {
  for (const path of ['README.md', 'README.zh.md', 'scripts/uninstall.sh', 'scripts/uninstall.ps1',
    'extensions/dsh-browser/src/panel/updates.ts', 'extensions/dsh-browser/src/panel/uninstall.ts']) {
    assert.doesNotMatch(read(path), /refs\/heads|raw\.githubusercontent\.com/u, path)
  }
  // The installers mention refs/heads once each: the explicit --unverified-branch path.
  for (const path of ['scripts/install.sh', 'scripts/install.ps1']) {
    const lines = read(path).split('\n').filter(line => /refs\/heads|raw\.githubusercontent\.com/u.test(line))
    assert.equal(lines.length, 1, path)
    assert.match(lines[0], /archive\/refs\/heads\/\$[Bb]ranch\./u, path)
  }
  for (const manifest of ['manifest.json', 'manifest.firefox.json']) {
    const csp = json(`extensions/dsh-browser/${manifest}`).content_security_policy.extension_pages
    assert.match(csp, /connect-src [^;]*https:\/\/api\.github\.com/u, manifest)
    assert.doesNotMatch(csp, /raw\.githubusercontent/u, manifest)
  }
})

test('the release-fetch block is identical in install and uninstall, per language', () => {
  assert.equal(fetchBlock('scripts/uninstall.sh'), fetchBlock('scripts/install.sh'))
  assert.equal(fetchBlock('scripts/uninstall.ps1'), fetchBlock('scripts/install.ps1'))
})

test('installers ask for the asset names package-release writes', () => {
  const names = assetNames('{tag}')
  assert.equal(names.sourceTar, 'dsh-browser-source-{tag}.tar.gz')
  assert.equal(names.sourceZip, 'dsh-browser-source-{tag}.zip')
  assert.equal(read('scripts/install.sh').includes(`release_fetch "$BOOTSTRAP_TMP/download" "$wanted" "${names.sourceTar}"`), true)
  assert.equal(read('scripts/install.ps1').includes(`-Assets @('${names.sourceZip}')`), true)
  assert.equal(read('scripts/uninstall.sh').includes('release_fetch "$download_dir" "$wanted" uninstall.mjs'), true)
  assert.equal(read('scripts/uninstall.ps1').includes("-Assets @('uninstall.mjs')"), true)
  for (const script of ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1', 'uninstall.mjs']) {
    assert.equal(BOOTSTRAP_SCRIPTS.includes(script), true, script)
  }
  // Both languages point at the same repository and refuse the same tags.
  for (const path of ['scripts/install.sh', 'scripts/install.ps1']) {
    assert.match(read(path), /natgurlain\/dsh-browser-agent/u, path)
    assert.equal(read(path).includes('^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?$'), true, path)
  }
})

test('the PowerShell scripts keep their UTF-8 BOM and LF line endings', () => {
  for (const path of ['scripts/install.ps1', 'scripts/uninstall.ps1']) {
    const bytes = readFileSync(new URL(`../../${path}`, import.meta.url))
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], path)
    assert.equal(bytes.includes(0x0d), false, path)
  }
})

test('the release workflow publishes the notes and attests every asset', () => {
  const workflow = read('.github/workflows/release.yml')
  assert.match(workflow, /package-release\.mjs --tag "\$TAG" --out release --notes release-notes\.md/u)
  assert.match(workflow, /--notes-file notes\/release-notes\.md/u)
  assert.match(workflow, /subject-path: release\/\*/u)
  assert.doesNotMatch(workflow, /--generate-notes/u)
})
