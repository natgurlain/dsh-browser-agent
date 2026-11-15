#!/usr/bin/env node
/**
 * Package release assets into an output directory:
 *   dsh-browser-chrome-<version>.zip   Chrome build (dist/), manifest `key` stripped
 *   dsh-browser-firefox-<version>.zip  Firefox build (dist-firefox/), manifest `key` stripped
 *   dsh-bridge-browser-<version>.tgz    `pnpm pack` of the bridge plugin
 *   dsh-browser-source-<version>.tar.gz  tracked source tree; what scripts/install.sh builds from
 *   dsh-browser-source-<version>.zip     the same tree for scripts/install.ps1
 *   install.sh install.ps1 uninstall.sh uninstall.ps1 uninstall.mjs
 *                                      the bootstrap scripts, so they can be fetched from the tag
 *   SHA256SUMS                         `sha256sum -c` compatible checksums of the above
 *
 * Usage: node scripts/package-release.mjs [--out release] [--tag v0.1.5] [--skip-build]
 *                                         [--installer-only] [--notes <file>]
 *
 * --installer-only writes only what the installers download (source archives, bootstrap
 * scripts, SHA256SUMS); it needs no build. --notes writes the release notes: the
 * CHANGELOG.md section for this version followed by the SHA-256 digests.
 *
 * Archives are deterministic (sorted entries, timestamps fixed to the release commit) so
 * the same commit and build output always yield the same checksums.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync, gzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('../', import.meta.url))
const extensionDir = join(root, 'extensions/dsh-browser')
const bridgeDir = join(root, 'packages/browser/bridge-browser')

/** Return the manifest text without a top-level `key` (store uploads reject it). */
export function stripManifestKey(text) {
  const manifest = JSON.parse(text)
  if (!Object.hasOwn(manifest, 'key')) return { text, stripped: false }
  delete manifest.key
  return { text: `${JSON.stringify(manifest, null, 2)}\n`, stripped: true }
}

function listFiles(dir) {
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(relative(dir, path).split(sep).join('/'))
      else throw new Error(`unsupported file type in build output: ${path}`)
    }
  }
  walk(dir)
  return files.sort()
}

/** The bootstrap scripts published next to the archives, under these exact names. */
export const BOOTSTRAP_SCRIPTS = ['install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1', 'uninstall.mjs']

/** Asset names for a release tag; the installers build the same names from the tag alone. */
export function assetNames(tag) {
  return {
    chrome: `dsh-browser-chrome-${tag}.zip`,
    firefox: `dsh-browser-firefox-${tag}.zip`,
    bridge: `dsh-bridge-browser-${tag}.tgz`,
    sourceTar: `dsh-browser-source-${tag}.tar.gz`,
    sourceZip: `dsh-browser-source-${tag}.zip`,
  }
}

/** DOS time/date words for a Unix timestamp (UTC); 1980-01-01 00:00 when omitted. */
function dosDateTime(epochSeconds) {
  if (epochSeconds === undefined) return { time: 0, date: (0 << 9) | (1 << 5) | 1 }
  const at = new Date(epochSeconds * 1000)
  const year = Math.max(at.getUTCFullYear(), 1980)
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  }
}

/** Build a deterministic zip from [{ name, data }] entries; `mtime` is a Unix timestamp. */
export function createZip(entries, { mtime } = {}) {
  const { time: DOS_TIME, date: DOS_DATE } = dosDateTime(mtime)
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data, { level: 9 })
    const useDeflate = compressed.length < data.length
    const body = useDeflate ? compressed : data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by: Unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(((0o100644 << 16) >>> 0), 38) // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + body.length
    if (offset > 0xffffffff) throw new Error('zip too large (zip64 not supported)')
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** Zip a built extension directory, stripping `key` from manifest.json. */
export function zipExtension(dir, outFile) {
  const files = listFiles(dir)
  if (!files.includes('manifest.json')) throw new Error(`${dir}: manifest.json missing (build first)`)
  let stripped = false
  const entries = files.map((name) => {
    let data = readFileSync(join(dir, name))
    if (name === 'manifest.json') {
      const result = stripManifestKey(data.toString('utf8'))
      stripped = result.stripped
      data = Buffer.from(result.text, 'utf8')
    }
    return { name, data }
  })
  writeFileSync(outFile, createZip(entries))
  return { files: files.length, stripped }
}

function tarHeader(name, size, mode, mtime) {
  let base = name
  let prefix = ''
  if (Buffer.byteLength(name) > 100) {
    // ustar: split at a slash so the last part fits 100 bytes and the rest 155.
    let split = -1
    for (let index = name.indexOf('/'); index >= 0; index = name.indexOf('/', index + 1)) {
      if (Buffer.byteLength(name.slice(index + 1)) <= 100 && Buffer.byteLength(name.slice(0, index)) <= 155) {
        split = index
        break
      }
    }
    if (split < 0) throw new Error(`path too long for a ustar archive: ${name}`)
    prefix = name.slice(0, split)
    base = name.slice(split + 1)
  }
  const header = Buffer.alloc(512)
  const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`
  header.write(base, 0, 'utf8')
  header.write(octal(mode, 8), 100)
  header.write(octal(0, 8), 108) // uid
  header.write(octal(0, 8), 116) // gid
  header.write(octal(size, 12), 124)
  header.write(octal(mtime, 12), 136)
  header.fill(' ', 148, 156) // the checksum field counts as spaces while summing
  header.write('0', 156) // regular file
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write(prefix, 345, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

/** Build a deterministic .tar.gz from [{ name, data, mode }] entries (regular files only). */
export function createTarGz(entries, { mtime = 0 } = {}) {
  const blocks = []
  for (const { name, data, mode = 0o644 } of entries) {
    blocks.push(tarHeader(name, data.length, mode, mtime), data)
    const padding = (512 - (data.length % 512)) % 512
    if (padding) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

/** Tracked files of the working tree as archive entries under `<prefix>/`. */
export function sourceEntries(repoRoot, prefix) {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${repoRoot}: ${listed.stderr || listed.error}`)
  return listed.stdout.split('\0').filter(Boolean).sort().map((name) => {
    const path = join(repoRoot, name)
    const info = statSync(path)
    if (!info.isFile()) throw new Error(`unsupported file type in source tree: ${name}`)
    return { name: `${prefix}/${name}`, data: readFileSync(path), mode: info.mode & 0o111 ? 0o755 : 0o644 }
  })
}

/** Commit time of HEAD (or SOURCE_DATE_EPOCH): archive timestamps that differ between releases. */
export function sourceEpoch(repoRoot) {
  if (/^\d+$/.test(process.env.SOURCE_DATE_EPOCH ?? '')) return Number(process.env.SOURCE_DATE_EPOCH)
  const shown = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: repoRoot, encoding: 'utf8' })
  const epoch = Number(shown.stdout.trim())
  if (shown.status !== 0 || !Number.isInteger(epoch) || epoch <= 0) throw new Error('cannot read the HEAD commit time')
  return epoch
}

/**
 * Write what the installers download into `outDir`: both source archives and the bootstrap
 * scripts. Returns the written paths. Needs no build output.
 */
export function writeInstallerAssets(repoRoot, outDir, tag) {
  const names = assetNames(tag)
  const mtime = sourceEpoch(repoRoot)
  const entries = sourceEntries(repoRoot, `dsh-browser-${tag}`)
  const tarball = join(outDir, names.sourceTar)
  writeFileSync(tarball, createTarGz(entries, { mtime }))
  const zip = join(outDir, names.sourceZip)
  writeFileSync(zip, createZip(entries, { mtime }))
  const written = [tarball, zip]
  for (const script of BOOTSTRAP_SCRIPTS) {
    const target = join(outDir, script)
    copyFileSync(join(repoRoot, 'scripts', script), target)
    written.push(target)
  }
  return written
}

/** The `## <tag>` section of CHANGELOG.md, without its heading. */
export function changelogSection(changelog, tag) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === `## ${tag}` || line.startsWith(`## ${tag} `))
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${tag}" section`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

/** Release notes: the changelog section, then the digests the installers verify against. */
export function releaseNotes(changelog, tag, checksumLines) {
  return [
    changelogSection(changelog, tag),
    '',
    '## SHA-256',
    '',
    'The installers download `SHA256SUMS` from this release and refuse to unpack or run a file',
    'whose digest differs. To check a download by hand, compare it with this list:',
    '',
    '```',
    ...checksumLines,
    '```',
    '',
  ].join('\n')
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Write SHA256SUMS (`<hex>  <name>`, sorted) for the given files. */
export function writeChecksums(files, outFile) {
  const lines = files.map(file => `${sha256File(file)}  ${basename(file)}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66)))
  writeFileSync(outFile, `${lines.join('\n')}\n`)
  return lines
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal})`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function parseArgs(argv) {
  const options = { out: join(root, 'release'), tag: process.env.RELEASE_TAG ?? '', build: true, installerOnly: false, notes: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') options.out = resolve(argv[++i])
    else if (arg === '--tag') options.tag = argv[++i]
    else if (arg === '--skip-build') options.build = false
    else if (arg === '--installer-only') options.installerOnly = true
    else if (arg === '--notes') options.notes = resolve(argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const version = readJson(join(extensionDir, 'manifest.json')).version
  for (const file of ['extensions/dsh-browser/manifest.firefox.json', 'extensions/dsh-browser/package.json', 'package.json']) {
    const other = readJson(join(root, file)).version
    if (other !== version) throw new Error(`${file} version ${other} != extensions/dsh-browser/manifest.json ${version}`)
  }
  if (options.tag && options.tag.replace(/^v/, '').replace(/-.*$/, '') !== version) {
    throw new Error(`tag ${options.tag} does not match extension version ${version}`)
  }

  if (options.build && !options.installerOnly) {
    // Published builds keep the plain version: no checkout build number.
    process.env.DSH_BROWSER_RELEASE_BUILD = '1'
    run('pnpm', ['--filter', '@natgurlain/dsh-bridge-browser', 'run', 'build'], root)
    run('pnpm', ['--filter', 'dsh-browser-extension', 'run', 'build'], root)
    run('pnpm', ['--filter', 'dsh-browser-extension', 'run', 'build:firefox'], root)
  }

  rmSync(options.out, { recursive: true, force: true })
  mkdirSync(options.out, { recursive: true })
  const label = options.tag || `v${version}`
  const names = assetNames(label)
  const assets = []

  if (!options.installerOnly) {
    for (const [browser, dist] of [['chrome', 'dist'], ['firefox', 'dist-firefox']]) {
      const file = join(options.out, names[browser])
      const built = readJson(join(extensionDir, dist, 'manifest.json')).version
      if (built !== version) {
        throw new Error(`${dist}/manifest.json is version ${built}, not ${version}: it is a checkout build with a build number; run without --skip-build`)
      }
      const { files, stripped } = zipExtension(join(extensionDir, dist), file)
      console.log(`${basename(file)}: ${files} files${stripped ? ', manifest key stripped' : ''}`)
      assets.push(file)
    }

    const before = new Set(readdirSync(options.out))
    run('pnpm', ['pack', '--pack-destination', options.out], bridgeDir)
    const tarballs = readdirSync(options.out).filter(name => name.endsWith('.tgz') && !before.has(name))
    if (tarballs.length !== 1) throw new Error(`expected one bridge tarball, found ${tarballs.join(', ') || 'none'}`)
    // Name by release tag so installers can find every asset from the tag alone.
    const tarball = join(options.out, names.bridge)
    renameSync(join(options.out, tarballs[0]), tarball)
    console.log(`${tarballs[0]} -> ${basename(tarball)}`)
    assets.push(tarball)
  }

  for (const file of writeInstallerAssets(root, options.out, label)) {
    console.log(basename(file))
    assets.push(file)
  }

  for (const file of assets) if (!statSync(file).size) throw new Error(`${file} is empty`)
  const lines = writeChecksums(assets, join(options.out, 'SHA256SUMS'))
  console.log(`SHA256SUMS:\n${lines.join('\n')}`)

  if (options.notes) {
    // A prerelease (v0.1.5-rc.1) ships the notes of the version it leads up to.
    const section = label.replace(/-.*$/, '')
    writeFileSync(options.notes, releaseNotes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), section, lines))
    console.log(`release notes -> ${options.notes}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
}
