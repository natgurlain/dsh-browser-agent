// Provision the bridge token for a zero-config Chrome install.
//
// Usage: provision-bridge-token.mjs <dshHome> <extensionDir>
//
// The dsh plugin authenticates the extension with the token in
// <dshHome>/ext-bridge-token (created by the plugin on first start). An
// installer runs before that, so this creates the token in the plugin's exact
// format when it is missing (64 hex digits + newline, 0600, atomic write) and
// copies it to <extensionDir>/bridge-token (0600), where the extension reads it
// through chrome.runtime.getURL. The copy is not a web-accessible resource.
// The plugin refreshes the copy itself on each start, so a later token
// rotation still reaches the extension.
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dshHome, extensionDir] = process.argv.slice(2)
if (!dshHome || !extensionDir) {
  process.stderr.write('Usage: provision-bridge-token.mjs <dshHome> <extensionDir>\n')
  process.exit(2)
}

function writePrivate(file, contents) {
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, contents, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
  chmodSync(file, 0o600)
}

function readToken(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

mkdirSync(dshHome, { recursive: true })
const tokenFile = join(dshHome, 'ext-bridge-token')
let token = readToken(tokenFile)
if (token === '') {
  token = randomBytes(32).toString('hex')
  writePrivate(tokenFile, `${token}\n`)
}
mkdirSync(extensionDir, { recursive: true })
writePrivate(join(extensionDir, 'bridge-token'), `${token}\n`)
