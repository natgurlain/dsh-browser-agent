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
//
// Both files are written without following symlinks: the temp file is created
// exclusively (O_CREAT|O_EXCL|O_NOFOLLOW, random name, 0600) and renamed over
// the target, and an existing symlink at either path aborts the run. On
// Windows an existing file is rewritten in place so a tightened ACL survives.
import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'

const [dshHome, extensionDir] = process.argv.slice(2)
if (!dshHome || !extensionDir) {
  process.stderr.write('Usage: provision-bridge-token.mjs <dshHome> <extensionDir>\n')
  process.exit(2)
}

const windows = process.platform === 'win32'
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

function fail(message) {
  process.stderr.write(`provision-bridge-token: ${message}\n`)
  process.exit(1)
}

/** lstat that maps "missing" to undefined and refuses symlinks. */
function inspect(file) {
  let info
  try {
    info = lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  if (info.isSymbolicLink()) fail(`refusing to use a symlink at ${file}`)
  return info
}

function writePrivate(file, contents) {
  const existing = inspect(file)
  if (windows && existing !== undefined) {
    const fd = openSync(file, constants.O_WRONLY | constants.O_TRUNC)
    try { writeSync(fd, contents) } finally { closeSync(fd) }
    return
  }
  const temp = `${file}.tmp-${randomBytes(8).toString('hex')}`
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600)
  try {
    try {
      writeSync(fd, contents)
      if (!windows) fchmodSync(fd, 0o600)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    try { unlinkSync(temp) } catch {}
    throw error
  }
}

/** Read a token without following symlinks; a group/other-readable file is tightened to 0600. */
function readToken(file) {
  if (inspect(file) === undefined) return ''
  const fd = openSync(file, constants.O_RDONLY | O_NOFOLLOW)
  try {
    if (!windows && (fstatSync(fd).mode & 0o077) !== 0) fchmodSync(fd, 0o600)
    return readFileSync(fd, 'utf8').trim()
  } finally {
    closeSync(fd)
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
