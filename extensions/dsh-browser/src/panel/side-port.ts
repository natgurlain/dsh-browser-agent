/**
 * Self-healing subscription ports for the panel's side channels
 * (`dsh-policy`, `dsh-watchers`, `dsh-learning`).
 *
 * Like the main panel port (api.ts), a side port can die under a live panel:
 * Firefox event pages and extension reloads invalidate it. Each side port
 * therefore reconnects shortly after a disconnect and re-sends its subscribe
 * message, so a safety indicator such as the taint banner never freezes on
 * its last state.
 *
 * @module
 */

import { useEffect, useRef } from 'react'

/** Delay before reconnecting, matching the main port. */
const RECONNECT_DELAY_MS = 150
/** Disconnects in a row without one message in between before giving up. */
const MAX_SILENT_RECONNECTS = 5

export interface SidePortOptions {
  /** Port name the background routes on. */
  name: string
  /** Sent on every (re)connected port, before anything else. */
  subscribe: (post: (message: Record<string, unknown>) => boolean) => void
  /** Every message from the background. */
  onMessage: (message: unknown) => void
  /** The current port went away (pending requests should fail). */
  onDisconnect?: () => void
  /** Test seam. */
  reconnectDelayMs?: number
}

export interface SidePort {
  /** Send on the live port; false while disconnected or when the port is dead. */
  post: (message: Record<string, unknown>) => boolean
  /** Close the port and stop reconnecting. */
  dispose: () => void
}

/** Open a side port that reconnects after the background restarts. */
export function openSidePort(options: SidePortOptions): SidePort {
  let port: chrome.runtime.Port | null = null
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let silentReconnects = 0

  const post = (message: Record<string, unknown>): boolean => {
    if (port === null) return false
    try {
      port.postMessage(message)
      return true
    } catch {
      return false
    }
  }

  const connect = (): void => {
    let next: chrome.runtime.Port
    try {
      next = chrome.runtime.connect({ name: options.name })
    } catch {
      // The extension context is gone; a reconnect loop would only spin.
      return
    }
    port = next
    next.onMessage.addListener((message: unknown) => {
      if (port !== next) return
      silentReconnects = 0
      options.onMessage(message)
    })
    next.onDisconnect.addListener(() => {
      if (port !== next) return
      port = null
      options.onDisconnect?.()
      if (disposed || silentReconnects >= MAX_SILENT_RECONNECTS) return
      silentReconnects += 1
      timer = setTimeout(() => {
        timer = undefined
        if (!disposed && port === null) connect()
      }, options.reconnectDelayMs ?? RECONNECT_DELAY_MS)
    })
    options.subscribe(post)
  }

  connect()
  return {
    post,
    dispose: () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      const current = port
      port = null
      try { current?.disconnect() } catch { /* already closed */ }
    },
  }
}

/**
 * React binding: one side port for the component's lifetime.
 * @returns a stable `post` that is a no-op while disconnected.
 */
export function useSidePort(name: string, subscribeMessage: Record<string, unknown>, onMessage: (message: unknown) => void): (message: Record<string, unknown>) => boolean {
  const portRef = useRef<SidePort | null>(null)
  const handlerRef = useRef(onMessage)
  handlerRef.current = onMessage
  const subscribeRef = useRef(subscribeMessage)
  subscribeRef.current = subscribeMessage
  useEffect(() => {
    if (typeof chrome === 'undefined' || chrome.runtime?.connect === undefined) return undefined
    const side = openSidePort({
      name,
      subscribe: (post) => { post(subscribeRef.current) },
      onMessage: (message) => { handlerRef.current(message) },
    })
    portRef.current = side
    return () => {
      if (portRef.current === side) portRef.current = null
      side.dispose()
    }
  }, [name])
  const postRef = useRef((message: Record<string, unknown>) => portRef.current?.post(message) ?? false)
  return postRef.current
}
