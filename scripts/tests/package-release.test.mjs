import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { crc32, inflateRawSync } from 'node:zlib'
import {
  createTarGz, createZip, sourceEntries, stripManifestKey, writeChecksums, zipExtension,
} from '../package-release.mjs'

// Minimal reader: walk the central directory and inflate each entry.
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'end of central directory missing')
  const count = buffer.readUInt16LE(end + 10)
  let pointer = buffer.readUInt32LE(end + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50)
    const method = buffer.readUInt16LE(pointer + 10)
    const crc = buffer.readUInt32LE(pointer + 16)
    const size = buffer.readUInt32LE(pointer + 20)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const offset = buffer.readUInt32LE(pointer + 42)
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength)
    const localName = buffer.readUInt16LE(offset + 26)
    const localExtra = buffer.readUInt16LE(offset + 28)
    const start = offset + 30 + localName + localExtra
    const body = buffer.subarray(start, start + size)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    assert.equal(crc32(data), crc, `${name}: crc mismatch`)
    entries.set(name, data)
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

test('stripManifestKey removes only the key field', () => {
  const { text, stripped } = stripManifestKey(JSON.stringify({ name: 'x', key: 'MIIB', version: '1.0.0' }))
  assert.equal(stripped, true)
  assert.deepEqual(JSON.parse(text), { name: 'x', version: '1.0.0' })
  const untouched = '{ "name": "x" }'
  assert.deepEqual(stripManifestKey(untouched), { text: untouched, stripped: false })
})

test('createZip round-trips and is deterministic', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello hello hello hello') },
    { name: 'dir/b.bin', data: Buffer.from([0, 1, 2]) },
    { name: 'empty', data: Buffer.alloc(0) },
  ]
  const zip = createZip(entries)
  assert.deepEqual(zip, createZip(entries))
  const read = readZip(zip)
  for (const { name, data } of entries) assert.deepEqual(read.get(name), data)
})

test('zipExtension strips the manifest key and SHA256SUMS matches', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-package-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dist = join(dir, 'dist')
  mkdirSync(join(dist, 'panel'), { recursive: true })
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '0.1.4', key: 'MIIBIjAN' }))
  writeFileSync(join(dist, 'panel/index.html'), '<!doctype html>')
  const out = join(dir, 'chrome.zip')
  assert.deepEqual(zipExtension(dist, out), { files: 2, stripped: true })
  const entries = readZip(readFileSync(out))
  assert.deepEqual([...entries.keys()], ['manifest.json', 'panel/index.html'])
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'))
  assert.equal('key' in manifest, false)
  assert.equal(manifest.version, '0.1.4')
  // Source build output keeps its key (local unpacked loads rely on it).
  assert.equal(JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')).key, 'MIIBIjAN')

  const sums = join(dir, 'SHA256SUMS')
  writeChecksums([out], sums)
  const digest = createHash('sha256').update(readFileSync(out)).digest('hex')
  assert.equal(readFileSync(sums, 'utf8'), `${digest}  chrome.zip\n`)
})

test('createTarGz is deterministic and unpacks with tar, long paths and modes included', {
  skip: process.platform === 'win32' ? 'checked with the system tar on Unix' : false,
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-package-release-tar-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const long = `${'nested-directory-name/'.repeat(6)}a-file-name-that-is-long-enough-to-need-the-ustar-prefix-field.txt`
  assert.ok(long.length > 100)
  const entries = [
    { name: 'root/plain.txt', data: Buffer.from('plain') },
    { name: 'root/scripts/run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
    { name: `root/${long}`, data: Buffer.from('x'.repeat(1500)) },
    { name: 'root/empty', data: Buffer.alloc(0) },
  ]
  const archive = createTarGz(entries, { mtime: 1_700_000_000 })
  assert.deepEqual(archive, createTarGz(entries, { mtime: 1_700_000_000 }))
  assert.notDeepEqual(archive, createTarGz(entries, { mtime: 1_700_000_001 }))
  writeFileSync(join(dir, 'a.tar.gz'), archive)
  const unpacked = spawnSync('tar', ['-xzf', join(dir, 'a.tar.gz'), '-C', dir, '--strip-components=1'], { encoding: 'utf8' })
  assert.equal(unpacked.status, 0, unpacked.stderr)
  assert.equal(readFileSync(join(dir, 'plain.txt'), 'utf8'), 'plain')
  assert.equal(readFileSync(join(dir, long), 'utf8'), 'x'.repeat(1500))
  assert.equal(readFileSync(join(dir, 'empty')).length, 0)
  assert.equal(statSync(join(dir, 'scripts/run.sh')).mode & 0o111, 0o111)
  assert.equal(statSync(join(dir, 'plain.txt')).mode & 0o111, 0)
  assert.equal(Math.floor(statSync(join(dir, 'plain.txt')).mtimeMs / 1000), 1_700_000_000)
  assert.throws(() => createTarGz([{ name: 'x'.repeat(300), data: Buffer.alloc(0) }]), /path too long/)
})

test('createZip stamps entries with the release time when one is given', () => {
  const entries = [{ name: 'a.txt', data: Buffer.from('a') }]
  const stamped = createZip(entries, { mtime: Date.UTC(2026, 10, 15, 12, 30, 44) / 1000 })
  assert.notDeepEqual(stamped, createZip(entries))
  // Local header: DOS time at offset 10, DOS date at offset 12.
  assert.equal(stamped.readUInt16LE(10), (12 << 11) | (30 << 5) | 22)
  assert.equal(stamped.readUInt16LE(12), ((2026 - 1980) << 9) | (11 << 5) | 15)
  assert.deepEqual(readZip(stamped).get('a.txt'), Buffer.from('a'))
})

test('the source archive holds the tracked files under one top-level directory', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const entries = sourceEntries(root, 'dsh-browser-v9.9.9')
  const names = entries.map(entry => entry.name)
  assert.equal(names.every(name => name.startsWith('dsh-browser-v9.9.9/')), true)
  for (const needed of ['package.json', 'pnpm-lock.yaml', 'scripts/install.sh', 'scripts/install.ps1',
    'extensions/dsh-browser/package.json', 'packages/browser/bridge-browser/package.json']) {
    assert.equal(names.includes(`dsh-browser-v9.9.9/${needed}`), true, needed)
  }
  assert.equal(names.some(name => /(^|\/)(node_modules|dist|\.git)\//.test(name)), false)
  assert.equal(entries.find(entry => entry.name.endsWith('/scripts/install.sh')).mode, 0o755)
  assert.deepEqual(names, names.toSorted())
})
