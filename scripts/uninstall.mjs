import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync, rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const BRIDGES = ['@natgurlain/dsh-browser-agent', 'dsh-browser-agent', '@natgurlain/dsh-bridge-browser', '@yuxianglin/dsh-bridge-browser', '@deepseek-ai/dsh-bridge-browser']
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']
// Files the bridge plugin writes into the DSH home (MCP bearer token and
// endpoint, session ledger, watcher records, workflow schedules, the record
// of extensions approved through pairing). The audit log
// (browser-audit/) and session workspaces (browser-sessions/) are user data and stay.
const BRIDGE_HOME_FILES = [
  'browser-mcp-token', 'browser-mcp.json',
  'browser-bridge-sessions.json', 'browser-bridge-watchers.json', 'browser-workflow-schedules.json',
  'browser-paired-extensions.json',
]
const KEPT_HOME_DATA = ['browser-audit', 'browser-sessions']
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// One language per run, chosen the way install.sh and uninstall.sh choose it:
// DSH_BROWSER_LANG=en|zh decides (uninstall.sh and uninstall.ps1 export it for --lang);
// otherwise Chinese when the locale is Chinese, and English for everything else.
function detectLanguage() {
  const forced = String(process.env.DSH_BROWSER_LANG ?? '').toLowerCase()
  if (forced.startsWith('zh')) return 'zh'
  if (forced.startsWith('en')) return 'en'
  const locale = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].find(Boolean) ?? ''
  if (/^zh/iu.test(locale)) return 'zh'
  if (locale !== '' && !/^(C|POSIX)(\.|$)/u.test(locale)) return 'en'
  try {
    if (process.platform === 'darwin') {
      // Prints a parenthesised list, one quoted language tag per line.
      const listed = spawnSync('defaults', ['read', '-g', 'AppleLanguages'], {
        encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      })
      const first = String(listed.stdout ?? '').split('\n')[1] ?? ''
      if (/^zh/iu.test(first.replace(/[", ]/gu, ''))) return 'zh'
    } else if (process.platform === 'win32') {
      // Windows sets none of the locale variables; uninstall.ps1 normally passes its choice.
      if (/^zh/iu.test(Intl.DateTimeFormat().resolvedOptions().locale)) return 'zh'
    }
  } catch {
    // The language list is a convenience; English is the answer when it cannot be read.
  }
  return 'en'
}

let language = detectLanguage()

// Every message exists in Chinese and in English, and a run prints one of them.
// Callers pass the Chinese text first and the English text second.
function text(zh, en) {
  return language === 'zh' ? zh : en
}

function fail(zh, en) {
  throw new Error(text(zh, en))
}

function pair(zh, en) {
  console.log(text(zh, en))
}

function stat(path) {
  return lstatSync(path, { throwIfNoEntry: false })
}

function regular(path, kind) {
  const item = stat(path)
  if (item && (item.isSymbolicLink() || !(kind === 'directory' ? item.isDirectory() : item.isFile()))) {
    fail(`路径类型不符合预期：${path}`, `Unexpected path type: ${path}`)
  }
  return item
}

function json(path) {
  if (!stat(path)) return undefined
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`JSON 文件必须包含对象：${path}`, `JSON file must contain an object: ${path}`)
  }
  return value
}

function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\u0000-\u001f]/u.test(path)) {
    fail(`请指定完整的绝对路径：${path}`, `Specify an absolute path: ${path}`)
  }
  return resolve(path)
}

function contains(parent, child) {
  const part = relative(toNamespacedPath(parent), toNamespacedPath(child))
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part))
}

function samePath(left, right) {
  return relative(toNamespacedPath(left), toNamespacedPath(right)) === ''
}

function dependencies(manifest) {
  return Object.assign({}, ...DEPENDENCY_FIELDS.map(field => manifest?.[field]))
}

function references(manifest) {
  const deps = dependencies(manifest)
  return BRIDGES.filter(name => Object.hasOwn(deps, name) || manifest?.dsh?.profile?.bundles?.includes(name))
}

function profiles(home) {
  const root = join(home, 'profiles')
  if (!stat(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return []
    const name = entry.name
    const dir = join(root, name)
    const manifest = json(join(dir, 'package.json'))
    return manifest ? [{ name, dir, manifest, references: references(manifest) }] : []
  })
}

// The DeepSeek Harness desktop app owns the reserved profile "desktop". DSH's own plugin
// operations refuse it; only the CLI bundled in the app may change it. The app is looked
// for where install.sh looks: --desktop-app or DSH_DESKTOP_APP ("none" skips it), then on
// macOS /Applications and ~/Applications.
function desktopCli(override) {
  if (override === 'none') return undefined
  const apps = override ? [absolute(override)]
    : process.platform === 'darwin'
      ? [join('/Applications', 'DeepSeek Harness.app'), join(homedir(), 'Applications', 'DeepSeek Harness.app')]
      : []
  for (const app of apps) {
    for (const runtime of [['Contents', 'Resources', 'runtime'], ['Resources', 'runtime'], ['resources', 'runtime']]) {
      for (const bin of [['cli', 'bin', 'dsh'], ['bin', 'dsh']]) {
        const cli = join(app, ...runtime, ...bin)
        if (stat(cli)?.isFile()) return { app, cli }
      }
    }
  }
  return undefined
}

function inspect(home, desktopApp) {
  const extension = join(home, 'browser-extension')
  const managed = join(home, 'dsh-browser')
  const sourceLink = join(home, 'profiles', 'web', '.dsh-browser-source')
  const token = join(home, 'ext-bridge-token')
  const installedProfiles = profiles(home)
  const web = installedProfiles.find(profile => profile.name === 'web')
  // The desktop profile is uninstalled like the web profile when the app's CLI is there to
  // do it and every reference is a dependency that CLI can remove. Otherwise it counts as
  // one more profile that still uses the bridge.
  const desktopProfile = installedProfiles.find(profile => profile.name === 'desktop' && profile.references.length > 0)
  const bundled = desktopProfile ? desktopCli(desktopApp) : undefined
  const desktopNames = desktopProfile
    ? BRIDGES.filter(name => Object.hasOwn(dependencies(desktopProfile.manifest), name)) : []
  const desktop = desktopProfile && bundled && desktopNames.length === desktopProfile.references.length
    ? { ...desktopProfile, ...bundled } : undefined
  const desktopKept = desktopProfile && !desktop ? desktopProfile : undefined
  const otherProfiles = installedProfiles.filter(profile => profile.name !== 'web' && profile !== desktopProfile
    && profile.references.length > 0).concat(desktopKept ?? [])
  const extensionStat = regular(extension, 'directory')
  const info = extensionStat ? json(join(extension, 'install-info.json')) : undefined
  if (info && (info.schemaVersion !== 1 || !['managed', 'checkout'].includes(info.mode))) {
    fail(`安装信息无法识别：${extension}`, `Unrecognized install metadata: ${extension}`)
  }
  if (info?.mode === 'checkout') absolute(info.sourceRoot)
  if (info?.dshHome !== undefined && !samePath(absolute(info.dshHome), home)) {
    fail(`安装记录指向其他目录：${info.dshHome}`, `Install metadata names a different home: ${info.dshHome}`)
  }
  if (extensionStat && !(info?.application === 'dsh-browser' && info.dshHome !== undefined)) {
    const manifest = json(join(extension, 'manifest.json'))
    const messages = json(join(extension, '_locales', 'en', 'messages.json'))
    if (!(manifest?.name === '__MSG_extensionName__' && ['dsh-browser-agent', 'dsh Browser Agent', 'dsh 浏览器助手', 'dsh Browser Assistant'].includes(messages?.extensionName?.message))) {
      fail(`无法确认扩展目录的归属：${extension}`, `Cannot establish ownership of extension directory: ${extension}`)
    }
  }
  const managedStat = stat(managed)
  const ownedManaged = managedStat?.isDirectory()
    && stat(join(managed, '.managed-by-install-sh'))?.isFile()
    && !stat(join(managed, '.git'))
    && !(info?.mode === 'checkout' && contains(managed, info.sourceRoot))
  const linkStat = stat(sourceLink)
  if (linkStat && !linkStat.isSymbolicLink()) {
    fail(`安装联接路径已被其他内容占用：${sourceLink}`, `The installation junction path contains other data: ${sourceLink}`)
  }
  regular(token, 'file')
  const bridgeFiles = BRIDGE_HOME_FILES.map(name => join(home, name))
  for (const file of bridgeFiles) regular(file, 'file')
  // While another profile still references a bridge plugin, keep the shared junction,
  // the source, the token and the bridge state files.
  const targets = [extension]
  if (otherProfiles.length === 0) {
    targets.push(sourceLink, token, ...bridgeFiles)
    if (ownedManaged) targets.push(managed)
  }
  return {
    home, managed, info, web, targets, desktop, desktopKept,
  }
}

async function loadRuntime(plan, runtimeRoot) {
  if (!plan.web?.references.length) return undefined
  const linkedRoots = runtimeRoot ? [] : plan.web.references.flatMap(name => {
    const manifest = join(plan.web.dir, 'node_modules', name, 'package.json')
    if (!stat(manifest)) return []
    const root = resolve(dirname(realpathSync(manifest)), '../../..')
    // A linked checkout is recognized by the root package name; installer-legacy.test.mjs
    // pins that name, so renaming the root package fails a test instead of breaking this.
    return json(join(root, 'package.json'))?.name === 'dsh-browser' ? [root] : []
  })
  const roots = runtimeRoot ? [absolute(runtimeRoot)]
    : [plan.info?.sourceRoot, plan.managed, ...linkedRoots, scriptRoot].filter(Boolean)
  const root = roots.find(candidate => stat(join(candidate, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')))
  if (!root) {
    fail('未找到 DSH 运行时。请使用 --runtime-root 指定已安装依赖的源码目录。',
      'DSH runtime not found. Pass --runtime-root with a checkout whose dependencies are installed.')
  }
  const anchor = realpathSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const require = createRequire(anchor)
  const operations = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
  const atomic = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
  return { ...operations, ...atomic, anchor }
}

function describe(plan) {
  pair(`卸载目标：${plan.home}`, `Uninstall target: ${plan.home}`)
  pair(`移除 web profile 桥插件：${plan.web?.references.join(', ') || '已移除'}`,
    `Remove web profile bridges: ${plan.web?.references.join(', ') || 'already removed'}`)
  if (plan.desktop) {
    pair(`通过 ${plan.desktop.cli} 移除 desktop profile 桥插件：${plan.desktop.references.join(', ')}`,
      `Remove desktop profile bridges through ${plan.desktop.cli}: ${plan.desktop.references.join(', ')}`)
  }
  noteKeptDesktop(plan)
  for (const path of plan.targets) {
    if (stat(path)) pair(`删除：${path}`, `Delete: ${path}`)
  }
}

function noteKeptDesktop(plan) {
  if (!plan.desktopKept) return
  pair(`desktop profile 仍引用桥插件（${plan.desktopKept.references.join(', ')}），但没有找到 DeepSeek Harness 应用自带的 CLI，无法移除；`
    + '因此保留源码、token 和桥状态文件。请用 --desktop-app 或 DSH_DESKTOP_APP 指定应用路径后重新运行。',
  `The desktop profile still references the bridge (${plan.desktopKept.references.join(', ')}), and the CLI bundled in the `
    + 'DeepSeek Harness app was not found to remove it; the source, token and bridge state files are kept. '
    + 'Pass --desktop-app or set DSH_DESKTOP_APP to the app and run this again.')
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Removes the bridge from the desktop profile with the app's own CLI. Its version override
// (allow-version) is never used. A failure stops the uninstall before any file is deleted.
function removeDesktopBridge(plan) {
  const { cli, dir } = plan.desktop
  const names = () => BRIDGES.filter(name => Object.hasOwn(dependencies(json(join(dir, 'package.json'))), name))
  for (const name of names()) {
    const args = ['plugin', '--profile', 'desktop', 'remove', name]
    const [command, commandArgs] = process.platform !== 'win32' && !executable(cli) ? ['/bin/sh', [cli, ...args]] : [cli, args]
    const result = spawnSync(command, commandArgs, {
      env: { ...process.env, DSH_HOME: plan.home }, stdio: ['ignore', 'inherit', 'inherit'],
    })
    if (result.error || result.status !== 0) {
      const outcome = result.error ? result.error.message
        : text(`退出码 ${result.status ?? result.signal}`, `exit code ${result.status ?? result.signal}`)
      fail(`从 desktop profile 移除插件失败，停止清理文件。命令：${command} ${commandArgs.join(' ')}（${outcome}）`,
        `Plugin removal from the desktop profile failed; file cleanup stopped. Command: ${command} ${commandArgs.join(' ')} (${outcome})`)
    }
  }
  if (names().length) {
    fail('desktop profile 中的桥插件依赖仍然存在，停止清理文件。', 'Bridge dependencies remain in the desktop profile; file cleanup stopped.')
  }
}

async function removeBridge(plan, runtime) {
  const dir = plan.web.dir
  const manifest = json(join(dir, 'package.json'))
  const names = BRIDGES.filter(name => Object.hasOwn(dependencies(manifest), name))
  if (names.length) {
    const result = await runtime.runProfilePnpm({
      profile: 'web', dir, home: plan.home, installAnchor: runtime.anchor, cwd: dir,
    }, ['remove', ...names, '-w'], {
      execution: 'cli', outputBytes: 16384, env: { DSH_HOME: plan.home },
      onOutput: (text, stream) => process[stream].write(text),
    })
    if (result.exitCode !== 0) fail(`移除插件失败，停止清理文件。诊断文件：${result.logPath}`,
      `Plugin removal failed; file cleanup stopped. Diagnostics: ${result.logPath}`)
  }
  const after = json(join(dir, 'package.json'))
  if (BRIDGES.some(name => Object.hasOwn(dependencies(after), name))) {
    fail('桥插件依赖仍然存在，停止清理文件。', 'Bridge dependencies remain; file cleanup stopped.')
  }
  // The native remove only tidies the dependencies it deleted; also drop a stray bundle
  // entry left behind by an interrupted install.
  const bundles = after.dsh?.profile?.bundles
  if (bundles?.some(name => BRIDGES.includes(name))) {
    after.dsh.profile.bundles = bundles.filter(name => !BRIDGES.includes(name))
    await runtime.saveManifest(dir, after)
  }
}

function cleanup(plan) {
  for (const path of plan.targets) {
    const now = stat(path)
    if (!now) continue
    // Node's rm does not descend into the target of a symlink or Windows junction.
    if (path === plan.managed) process.chdir(plan.home)
    rmSync(path, { recursive: now.isDirectory(), force: false })
  }
}

async function main() {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
  if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 9)) {
    fail('卸载需要 Node.js 24.9.0 或更新版本。', 'Uninstall requires Node.js 24.9.0 or newer.')
  }
  const { values } = parseArgs({ options: {
    home: { type: 'string' }, 'runtime-root': { type: 'string' },
    'desktop-app': { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
    lang: { type: 'string' },
  } })
  if (values.lang !== undefined) {
    const wanted = values.lang.toLowerCase()
    if (wanted !== 'en' && wanted !== 'zh') fail(`--lang 只接受 en 或 zh：${values.lang}`, `--lang accepts en or zh: ${values.lang}`)
    language = wanted
  }
  if (values.help) {
    console.log(text(`用法：uninstall [--home <path>] [--dry-run] [--runtime-root <checkout>] [--desktop-app <path>] [--lang en|zh]

  --home <path>             DSH 目录（默认为 DSH_HOME 或 ~/.dsh）
  --dry-run                 只列出将要移除的文件和插件
  --runtime-root <checkout> 使用该 checkout 中的 DSH 依赖
  --desktop-app <path>      DeepSeek Harness 桌面应用，用它自带的 CLI 从 desktop profile 移除插件
                            （默认为 DSH_DESKTOP_APP，其次是 macOS 上的 /Applications 和
                            ~/Applications；"none" 表示不处理 desktop profile）
  --lang en|zh              输出语言（默认为 DSH_BROWSER_LANG，其次在中文环境下为中文，
                            其他环境为英文）`,
    `Usage: uninstall [--home <path>] [--dry-run] [--runtime-root <checkout>] [--desktop-app <path>] [--lang en|zh]

  --home <path>             DSH directory (defaults to DSH_HOME or ~/.dsh)
  --dry-run                 List the files and plugins to remove
  --runtime-root <checkout> Use DSH dependencies from this checkout
  --desktop-app <path>      DeepSeek Harness desktop app whose bundled CLI removes the plugin from
                            the desktop profile (defaults to DSH_DESKTOP_APP, then /Applications
                            and ~/Applications on macOS; "none" leaves the desktop profile alone)
  --lang en|zh              Language of the output (defaults to DSH_BROWSER_LANG, then Chinese
                            when the locale is Chinese and English otherwise)`))
    return
  }
  let home = values.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  home = absolute(home)
  if (stat(home)) home = realpathSync(home)
  regular(home, 'directory')
  const plan = inspect(home, values['desktop-app'] ?? (process.env.DSH_DESKTOP_APP || undefined))
  if (values['dry-run']) {
    describe(plan)
    return
  }
  const runtime = await loadRuntime(plan, values['runtime-root'])
  pair('正在卸载 dsh-browser…', 'Uninstalling dsh-browser…')
  const execute = async () => {
    if (runtime) await removeBridge(plan, runtime)
    if (plan.desktop) removeDesktopBridge(plan)
    cleanup(plan)
  }
  if (runtime) await runtime.withFileLock(join(plan.web.dir, 'package.json'), execute)
  else await execute()
  noteKeptDesktop(plan)
  const kept = KEPT_HOME_DATA.map(name => join(home, name)).filter(path => stat(path))
  if (kept.length) {
    pair(`已保留审计日志与会话工作区，可手动删除：${kept.join(', ')}`,
      `Kept the audit log and session workspaces; delete them by hand if you want: ${kept.join(', ')}`)
  }
  pair('请在浏览器扩展管理页面移除“dsh-browser-agent”，完成卸载。',
    'Remove dsh-browser-agent from your browser to finish uninstalling.')
  console.log('Chrome: chrome://extensions · Edge: edge://extensions · Firefox: about:addons')
  pair('如果 DSH 正在运行，请重启 DSH。', 'If DSH is running, restart it.')
  if (plan.desktop) {
    pair('如果 DeepSeek Harness 桌面应用正在运行，请退出并重新打开。', 'If the DeepSeek Harness desktop app is running, quit and reopen it.')
  }
}

await main()
