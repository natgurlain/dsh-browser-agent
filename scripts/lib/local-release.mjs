/**
 * A local stand-in for GitHub Releases, for exercising the installers without the network.
 *
 * serveReleases() answers the URLs scripts/install.sh, uninstall.sh and install.ps1 request:
 * the web layout (/<repo>/releases/latest, /releases/tag/<tag>, /releases/download/<tag>/<asset>,
 * /archive/refs/heads/<branch>.tar.gz) and, under /api, the two REST calls the token path
 * uses. Point the installer at it with DSH_BROWSER_GITHUB_URL (and DSH_BROWSER_GITHUB_API_URL).
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

export const REPOSITORY = 'natgurlain/dsh-browser-agent'

/**
 * @param {object} options
 * @param {Record<string, string>} options.releases  tag -> directory holding that release's assets
 * @param {string} [options.latest]                  tag /releases/latest points at (none: no release yet)
 * @param {Record<string, string>} [options.branches] branch -> .tar.gz file
 * @param {boolean} [options.private]                answer every anonymous request with 404
 * @param {string} [options.token]                   bearer token the /api routes require
 * @param {string[]} [options.truncate]              asset names sent with a full Content-Length but half a body
 */
export async function serveReleases({ releases, latest, branches = {}, private: isPrivate = false, token, truncate = [] }) {
  /** @type {{ method: string, url: string, authorization: string | undefined }[]} */
  const requests = []
  let origin = ''

  const sendFile = (response, path, name) => {
    if (!existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404).end('Not Found')
      return
    }
    const body = readFileSync(path)
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length })
    if (truncate.includes(name)) {
      response.write(body.subarray(0, Math.floor(body.length / 2)), () => response.destroy())
      return
    }
    response.end(body)
  }

  const describe = (tag) => ({
    tag_name: tag,
    assets: listAssets(releases[tag])
      .map(name => ({ name, url: `${origin}/api/repos/${REPOSITORY}/releases/assets/${tag}/${name}` })),
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    requests.push({ method: request.method ?? '', url: url.pathname, authorization: request.headers.authorization })
    const path = decodeURIComponent(url.pathname)

    const api = `/api/repos/${REPOSITORY}/releases/`
    if (path.startsWith(api)) {
      if (!token || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(token ? 401 : 404).end('{}')
        return
      }
      const rest = path.slice(api.length)
      const tag = rest === 'latest' ? latest : rest.startsWith('tags/') ? rest.slice('tags/'.length) : undefined
      if (tag !== undefined && releases[tag]) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(describe(tag)))
        return
      }
      const asset = /^assets\/([^/]+)\/([^/]+)$/.exec(rest)
      if (asset && releases[asset[1]]) {
        sendFile(response, join(releases[asset[1]], asset[2]), asset[2])
        return
      }
      response.writeHead(404).end('{}')
      return
    }

    const web = `/${REPOSITORY}/`
    if (isPrivate || !path.startsWith(web)) {
      response.writeHead(404).end('Not Found')
      return
    }
    const rest = path.slice(web.length)
    if (rest === 'releases/latest') {
      response.writeHead(302, { location: latest ? `${web}releases/tag/${latest}` : `${web}releases` }).end()
      return
    }
    if (rest === 'releases') {
      response.writeHead(200).end('releases')
      return
    }
    const tagPage = /^releases\/tag\/([^/]+)$/.exec(rest)
    if (tagPage) {
      response.writeHead(releases[tagPage[1]] ? 200 : 404).end(tagPage[1])
      return
    }
    const download = /^releases\/download\/([^/]+)\/([^/]+)$/.exec(rest)
    if (download && releases[download[1]]) {
      sendFile(response, join(releases[download[1]], download[2]), download[2])
      return
    }
    const branch = /^archive\/refs\/heads\/(.+)\.(?:tar\.gz|zip)$/.exec(rest)
    if (branch && branches[branch[1]]) {
      sendFile(response, branches[branch[1]], branch[1])
      return
    }
    response.writeHead(404).end('Not Found')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  origin = `http://127.0.0.1:${port}`

  return {
    /** Value for DSH_BROWSER_GITHUB_URL. */
    url: origin,
    /** Value for DSH_BROWSER_GITHUB_API_URL. */
    apiUrl: `${origin}/api`,
    requests,
    /** Paths requested so far, without the repository prefix. */
    paths: () => requests.map(entry => entry.url.replace(`/${REPOSITORY}/`, '')),
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve(undefined))
    }),
  }
}

function listAssets(directory) {
  return readdirSync(directory).sort()
}

/**
 * Run a command to completion without blocking the event loop (the release server lives in
 * this process). Resolves with the exit status and both streams.
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
export function run(command, args, { env, cwd, input, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}
