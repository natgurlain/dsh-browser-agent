// The .sh scripts run under the bash 3.2 that macOS ships (/bin/bash). Two classes of mistake
// pass every test on a current bash and break there; both are cheap to find in the source.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// bash 3.2 takes the first byte of a multibyte character for part of the variable name:
// "$BROWSER_NAME（" fails with "BROWSER_NAME?: unbound variable". Write "${BROWSER_NAME}（".
const UNBRACED = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/u
const BASH4 = {
  'case conversion ${name,,} / ${name^^}': /\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?(,,?|\^\^?)[^}]*\}/u,
  'associative array': /\b(declare|local|typeset)\s+-[A-Za-z]*A/u,
  'mapfile / readarray': /(^|[\s;&|(])(mapfile|readarray)\b/u,
  '&>> redirection': /&>>/u,
  '|& pipe': /\|&/u,
}

function shellScripts(directory = join(root, 'scripts')) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : shellScripts(path)
    return entry.name.endsWith('.sh') ? [path] : []
  })
}

/** Every line of every script that matches, as "path:line: text". */
function findings(pattern, { code = false } = {}) {
  return shellScripts().flatMap(path => readFileSync(path, 'utf8').split('\n').flatMap((line, index) => {
    // A comment may name a construct; only code can run it.
    const text = code ? line.replace(/^\s*#.*$/u, '') : line
    return pattern.test(text) ? [`${relative(root, path)}:${index + 1}: ${line.trim()}`] : []
  }))
}

test('the installers are among the scripts checked', () => {
  const names = shellScripts().map(path => relative(root, path).replaceAll('\\', '/'))
  for (const name of ['scripts/install.sh', 'scripts/uninstall.sh']) assert.equal(names.includes(name), true, name)
})

test('no $NAME is directly followed by a non-ASCII character', () => {
  assert.deepEqual(findings(UNBRACED), [])
})

test('no bash 4 syntax', () => {
  for (const [name, pattern] of Object.entries(BASH4)) assert.deepEqual(findings(pattern, { code: true }), [], name)
})

test('the patterns find what they are for', () => {
  assert.equal(UNBRACED.test('print "打开 $BROWSER_NAME（注意不是 Firefox）："'), true)
  assert.equal(UNBRACED.test('print "打开 ${BROWSER_NAME}（地址栏输入 $BROWSER_URL 。$1：$#）"'), false)
  const hits = text => Object.keys(BASH4).filter(name => BASH4[name].test(text))
  assert.deepEqual(hits('lower="${LANG,,}"'), ['case conversion ${name,,} / ${name^^}'])
  assert.deepEqual(hits('upper="${names[0]^^}"; first="${name^}"'), ['case conversion ${name,,} / ${name^^}'])
  assert.deepEqual(hits('declare -gA seen'), ['associative array'])
  assert.deepEqual(hits('  mapfile -t lines <file'), ['mapfile / readarray'])
  assert.deepEqual(hits('run &>>"$log"'), ['&>> redirection'])
  assert.deepEqual(hits('make |& tee log'), ['|& pipe'])
  assert.deepEqual(hits('local -a forwarded=(); name="${name//\\{tag\\}/$TAG}, ${b:-^}"; a || b && c >>"$log" 2>&1'), [])
})
