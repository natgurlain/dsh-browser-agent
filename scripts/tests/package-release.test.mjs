import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { crc32, inflateRawSync } from 'node:zlib'
import { createZip, stripManifestKey, writeChecksums, zipExtension } from '../package-release.mjs'

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
