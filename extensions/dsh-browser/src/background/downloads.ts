/**
 * `browser_downloads`: list recent downloads or wait for one to finish, and
 * report local file paths the host can read.
 *
 * `downloads` is an optional permission. The background cannot request it
 * (permission prompts need a user gesture), so the approval card for the
 * first call carries `permission: 'downloads'` and the side panel requests
 * it from the Allow click.
 *
 * @module
 */

/** One reported download. */
export interface DownloadRecord {
  id: number
  /** Absolute local path chosen by the browser. */
  path: string
  url: string
  state: string
  mime?: string
  bytes: number
  totalBytes?: number
  startTime: string
  endTime?: string
  error?: string
  exists?: boolean
}

/** The subset of `chrome.downloads` this module uses (injectable for tests). */
export interface DownloadsApi {
  search(query: { orderBy?: string[]; limit?: number; id?: number }): Promise<chrome.downloads.DownloadItem[]>
  onChanged: {
    addListener(listener: (delta: chrome.downloads.DownloadDelta) => void): void
    removeListener(listener: (delta: chrome.downloads.DownloadDelta) => void): void
  }
  onCreated?: {
    addListener(listener: (item: chrome.downloads.DownloadItem) => void): void
    removeListener(listener: (item: chrome.downloads.DownloadItem) => void): void
  }
}

/** Failure with a stable code for tool answers. */
export class DownloadsError extends Error {
  constructor(readonly code: 'bad-args' | 'action-failed' | 'timeout' | 'input-unavailable', message: string) {
    super(message)
    this.name = 'DownloadsError'
  }
}

export const DOWNLOADS_PERMISSION = 'downloads'
const DEFAULT_WAIT_MS = 30_000
const MAX_WAIT_MS = 60_000
const MAX_PATTERN_CHARS = 200
/** How far back a wait looks: the click that started a download comes first. */
const WAIT_LOOKBACK_MS = 15_000
/** Downloads a wait already reported, so a second wait finds the next one. */
const reportedDownloads = new Set<number>()

/** Whether the optional downloads permission is granted. */
export async function hasDownloadsPermission(): Promise<boolean> {
  const permissions = (globalThis as { chrome?: { permissions?: { contains?: (value: { permissions: string[] }) => Promise<boolean> } } }).chrome?.permissions
  if (typeof permissions?.contains !== 'function') return false
  try {
    return await permissions.contains({ permissions: [DOWNLOADS_PERMISSION] })
  } catch {
    return false
  }
}

/** The live downloads API, present only once the permission is granted. */
export function downloadsApi(): DownloadsApi | undefined {
  const api = (globalThis as { chrome?: { downloads?: DownloadsApi } }).chrome?.downloads
  return api !== undefined && typeof api.search === 'function' ? api : undefined
}

function toRecord(item: chrome.downloads.DownloadItem): DownloadRecord {
  return {
    id: item.id,
    path: item.filename,
    url: item.finalUrl ?? item.url,
    state: item.state,
    ...(item.mime === undefined || item.mime === '' ? {} : { mime: item.mime }),
    bytes: item.bytesReceived,
    ...(item.totalBytes > 0 ? { totalBytes: item.totalBytes } : {}),
    startTime: item.startTime,
    ...(item.endTime === undefined ? {} : { endTime: item.endTime }),
    ...(item.error === undefined ? {} : { error: item.error }),
    ...(item.exists === undefined ? {} : { exists: item.exists }),
  }
}

/** Parse the `filenameRegex` argument. */
export function parseFilenamePattern(value: unknown): RegExp | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '' || value.length > MAX_PATTERN_CHARS) {
    throw new DownloadsError('bad-args', `filenameRegex must be a non-empty string of at most ${MAX_PATTERN_CHARS} characters.`)
  }
  try {
    return new RegExp(value, 'i')
  } catch {
    throw new DownloadsError('bad-args', 'filenameRegex is not a valid regular expression.')
  }
}

/** List recent downloads, newest first. */
export async function listDownloads(api: DownloadsApi, limit: number): Promise<DownloadRecord[]> {
  const items = await api.search({ orderBy: ['-startTime'], limit })
  return items.map(toRecord)
}

/**
 * Wait for a download to complete. A download that finished in the second
 * before the call (the click that started it usually comes first) counts too.
 */
export async function waitForDownload(
  api: DownloadsApi,
  options: { pattern?: RegExp; timeoutMs: number; since: number; signal?: AbortSignal },
): Promise<DownloadRecord> {
  const matches = (item: chrome.downloads.DownloadItem): boolean => {
    if (reportedDownloads.has(item.id)) return false
    if (Date.parse(item.startTime) < options.since) return false
    return options.pattern === undefined || options.pattern.test(item.filename)
  }
  return new Promise<DownloadRecord>((resolve, reject) => {
    let done = false
    const finish = (outcome: { record?: DownloadRecord; error?: DownloadsError }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      api.onChanged.removeListener(onChanged)
      options.signal?.removeEventListener('abort', onAbort)
      if (outcome.record !== undefined) resolve(outcome.record)
      else reject(outcome.error)
    }
    const check = async (id?: number): Promise<void> => {
      const items = id === undefined
        ? await api.search({ orderBy: ['-startTime'], limit: 20 })
        : await api.search({ id })
      for (const item of items) {
        if (!matches(item)) continue
        if (item.state === 'complete') {
          reportedDownloads.add(item.id)
          finish({ record: toRecord(item) })
          return
        }
        if (item.state === 'interrupted' && id !== undefined) {
          finish({ error: new DownloadsError('action-failed', `The download ${item.filename || item.url} was interrupted (${item.error ?? 'unknown reason'}).`) })
          return
        }
      }
    }
    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted' || delta.filename !== undefined) {
        void check(delta.id).catch(() => undefined)
      }
    }
    const onAbort = (): void => { finish({ error: new DownloadsError('action-failed', 'The wait was cancelled.') }) }
    const timer = setTimeout(() => {
      finish({ error: new DownloadsError('timeout', `No matching download completed within ${options.timeoutMs} ms.`) })
    }, options.timeoutMs)
    api.onChanged.addListener(onChanged)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    void check().catch(() => undefined)
  })
}

/** Run one `browser_downloads` call and render its text. */
export async function runDownloadsTool(
  args: Record<string, unknown>,
  api: DownloadsApi | undefined,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<string> {
  if (api === undefined) {
    throw new DownloadsError('input-unavailable', 'The browser downloads permission has not been granted. Allow the browser_downloads request in the side panel and accept the browser prompt, then retry.')
  }
  const action = args.action === undefined ? 'list' : args.action
  if (action === 'list') {
    const limit = args.limit === undefined ? 10 : args.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new DownloadsError('bad-args', 'limit must be an integer between 1 and 50.')
    }
    const records = await listDownloads(api, limit)
    return JSON.stringify({ downloads: records }, null, 2)
  }
  if (action !== 'wait') throw new DownloadsError('bad-args', 'action must be list or wait.')
  const timeoutMs = args.timeoutMs === undefined ? DEFAULT_WAIT_MS : args.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_WAIT_MS) {
    throw new DownloadsError('bad-args', `timeoutMs must be an integer between 1000 and ${MAX_WAIT_MS}.`)
  }
  const pattern = parseFilenamePattern(args.filenameRegex)
  const record = await waitForDownload(api, {
    ...(pattern === undefined ? {} : { pattern }),
    timeoutMs,
    // Downloads usually start from the click just before this call.
    since: now() - WAIT_LOOKBACK_MS,
    ...(signal === undefined ? {} : { signal }),
  })
  return JSON.stringify({ download: record }, null, 2)
}
