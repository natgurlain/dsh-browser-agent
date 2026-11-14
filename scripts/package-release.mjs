#!/usr/bin/env node
/**
 * Package release assets into an output directory:
 *   dsh-browser-chrome-<version>.zip   Chrome build (dist/), manifest `key` stripped
 *   dsh-browser-firefox-<version>.zip  Firefox build (dist-firefox/), manifest `key` stripped
 *   dsh-bridge-browser-<version>.tgz    `pnpm pack` of the bridge plugin
 *   SHA256SUMS                         `sha256sum -c` compatible checksums of the above
 *
 * Usage: node scripts/package-release.mjs [--out release] [--tag v0.1.4] [--skip-build]
 *
 * Zips are deterministic (sorted entries, fixed timestamps) so the same build
 * output always yields the same checksums.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

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

// 1980-01-01 00:00 in DOS time/date format.
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1

/** Build a deterministic zip from [{ name, data }] entries. */
export function createZip(entries) {
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
  const options = { out: join(root, 'release'), tag: process.env.RELEASE_TAG ?? '', build: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') options.out = resolve(argv[++i])
    else if (arg === '--tag') options.tag = argv[++i]
    else if (arg === '--skip-build') options.build = false
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const version = readJson(join(extensionDir, 'manifest.json')).version
  for (const file of ['manifest.firefox.json', 'package.json']) {
    const other = readJson(join(extensionDir, file)).version
    if (other !== version) throw new Error(`extensions/dsh-browser/${file} version ${other} != manifest.json ${version}`)
  }
  if (options.tag && options.tag.replace(/^v/, '').replace(/-.*$/, '') !== version) {
    throw new Error(`tag ${options.tag} does not match extension version ${version}`)
  }

  if (options.build) {
    run('pnpm', ['--filter', '@natgurlain/dsh-bridge-browser', 'run', 'build'], root)
    run('pnpm', ['--filter', 'dsh-browser-extension', 'run', 'build'], root)
    run('pnpm', ['--filter', 'dsh-browser-extension', 'run', 'build:firefox'], root)
  }

  rmSync(options.out, { recursive: true, force: true })
  mkdirSync(options.out, { recursive: true })
  const label = options.tag || `v${version}`
  const assets = []

  for (const [browser, dist] of [['chrome', 'dist'], ['firefox', 'dist-firefox']]) {
    const file = join(options.out, `dsh-browser-${browser}-${label}.zip`)
    const { files, stripped } = zipExtension(join(extensionDir, dist), file)
    console.log(`${basename(file)}: ${files} files${stripped ? ', manifest key stripped' : ''}`)
    assets.push(file)
  }

  const before = new Set(readdirSync(options.out))
  run('pnpm', ['pack', '--pack-destination', options.out], bridgeDir)
  const tarballs = readdirSync(options.out).filter(name => name.endsWith('.tgz') && !before.has(name))
  if (tarballs.length !== 1) throw new Error(`expected one bridge tarball, found ${tarballs.join(', ') || 'none'}`)
  // Name by release tag so installers can find every asset from the tag alone.
  const tarball = join(options.out, `dsh-bridge-browser-${label}.tgz`)
  renameSync(join(options.out, tarballs[0]), tarball)
  console.log(`${tarballs[0]} -> ${basename(tarball)}`)
  assets.push(tarball)

  for (const file of assets) if (!statSync(file).size) throw new Error(`${file} is empty`)
  const lines = writeChecksums(assets, join(options.out, 'SHA256SUMS'))
  console.log(`SHA256SUMS:\n${lines.join('\n')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
}
