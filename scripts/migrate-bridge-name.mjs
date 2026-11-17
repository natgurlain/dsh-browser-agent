#!/usr/bin/env node
/**
 * Carries saved bridge settings over the package rename
 * `@natgurlain/dsh-bridge-browser` -> `dsh-browser-agent` (v0.3.1).
 *
 *   node scripts/migrate-bridge-name.mjs [--lang en|zh] <dsh-home> <profile>...
 *
 * DSH saves a plugin's settings (the settings page, `ctx.configEditor`) as a row of the
 * profile's `cordis.patch.yml` that names the package: `- id: bridge-browser`,
 * `name: '@natgurlain/dsh-bridge-browser'`, `config: {...}`. A row whose `name` differs
 * from the running entry's package is skipped (cordis-plugin-include: "patch: name
 * mismatch ... skipping"), so after the rename every saved setting, `autoReview: false`
 * included, would silently stop applying. This rewrites that `name:` value, and nothing
 * else, in:
 *
 * - `<dsh-home>/profiles/<profile>/cordis.patch.yml` for each profile named, which the
 *   installer passes once it has removed the old registration from that profile;
 * - `<dsh-home>/cordis.patch.yml`, the home patch every profile reads, only when no
 *   profile under `<dsh-home>/profiles` still lists the old package (as a dependency or
 *   a selected bundle): a profile the installer did not re-register keeps running the
 *   old package, and its home rows must keep matching it.
 *
 * Only the direct predecessor's name is rewritten. Rows naming the earlier upstream
 * packages (`@deepseek-ai/...`, `@yuxianglin/...`) have not applied since 0.2.0 and are
 * left as they are, so no stale config of another package comes back to life.
 *
 * Comments, ordering, quoting and `!!js` expressions are kept: the rewrite is a textual
 * replacement of one quoted scalar after `name:`. Files are replaced atomically with
 * their previous mode. Missing files are skipped. Running it again changes nothing.
 * Prints one line per rewritten file, in the installer's language (--lang, default
 * English); exits 1 with a message on an error.
 */

import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const OLD_NAME = '@natgurlain/dsh-bridge-browser'
export const NEW_NAME = 'dsh-browser-agent'
const PATCH_FILE = 'cordis.patch.yml'
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']

// `name: '@natgurlain/dsh-bridge-browser'` in block or flow style, single or double quoted
// (a plain scalar cannot start with `@`). The value must end the mapping entry.
const NAME_ROW = /(^|[\s{,])(name[ \t]*:[ \t]*)(['"])@natgurlain\/dsh-bridge-browser\3(?=[ \t]*(?:[,}#\r\n]|$))/gmu

/** The patch text with every old-name `name:` value replaced, and how many there were. */
export function rewritePatchText(text) {
  let count = 0
  const next = text.replace(NAME_ROW, (_match, lead, key, quote) => {
    count += 1
    return `${lead}${key}${quote}${NEW_NAME}${quote}`
  })
  return { text: next, count }
}

/** Rewrite one patch file in place; returns the number of rows rewritten (0 when absent). */
export function migratePatchFile(path) {
  const item = lstatSync(path, { throwIfNoEntry: false })
  if (!item) return 0
  // A linked patch is edited where it lives, so the link stays a link.
  const target = item.isSymbolicLink() ? realpathSync(path) : path
  if (!statSync(target).isFile()) throw new Error(`not a file: ${path}`)
  const { text, count } = rewritePatchText(readFileSync(target, 'utf8'))
  if (count === 0) return 0
  const mode = statSync(target).mode & 0o7777
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`)
  try {
    writeFileSync(temporary, text, { mode })
    chmodSync(temporary, mode)
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return count
}

/** Whether a profile manifest still lists the old package as a dependency or a selected bundle. */
export function profileListsOldName(profileDir) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return false
  }
  if (manifest === null || typeof manifest !== 'object') return false
  const listed = DEPENDENCY_FIELDS.some(field => Object.hasOwn(manifest[field] ?? {}, OLD_NAME))
  const bundles = manifest.dsh?.profile?.bundles
  return listed || (Array.isArray(bundles) && bundles.includes(OLD_NAME))
}

/**
 * Migrate the named profiles' patches, then the home patch when no profile still uses the
 * old package. Returns the files rewritten with their row counts, and whether the home
 * patch was left for a profile that still runs the old package.
 */
export function migrate(home, profiles) {
  const rewritten = []
  for (const profile of profiles) {
    if (profile === '' || /[\\/]/u.test(profile) || profile === '.' || profile === '..') {
      throw new Error(`invalid profile name: ${JSON.stringify(profile)}`)
    }
    const path = join(home, 'profiles', profile, PATCH_FILE)
    const count = migratePatchFile(path)
    if (count > 0) rewritten.push({ path, count })
  }
  const profilesDir = join(home, 'profiles')
  const remaining = lstatSync(profilesDir, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(profilesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .filter(name => profileListsOldName(join(profilesDir, name)))
    : []
  const homePatch = join(home, PATCH_FILE)
  if (remaining.length === 0) {
    const count = migratePatchFile(homePatch)
    if (count > 0) rewritten.push({ path: homePatch, count })
  }
  return { rewritten, homeKeptFor: remaining }
}

function main(args) {
  let language = 'en'
  if (args[0] === '--lang') {
    language = String(args[1] ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    args = args.slice(2)
  }
  const text = (zh, en) => language === 'zh' ? zh : en
  const [home, ...profiles] = args
  if (!home) {
    console.error('usage: node scripts/migrate-bridge-name.mjs [--lang en|zh] <dsh-home> <profile>...')
    return 2
  }
  try {
    const { rewritten } = migrate(home, profiles)
    for (const { path, count } of rewritten) {
      console.log(text(`已保存的桥插件设置改为指向 ${NEW_NAME}：${path}（${count} 处）`,
        `Saved bridge settings now name ${NEW_NAME}: ${path} (${count})`))
    }
    return 0
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(text(`无法把已保存的桥插件设置迁移到 ${NEW_NAME}：${reason}`,
      `Could not carry the saved bridge settings over to ${NEW_NAME}: ${reason}`))
    return 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
