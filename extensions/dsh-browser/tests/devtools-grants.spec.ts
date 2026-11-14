// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { DEVTOOLS_GRANT_TTL_MS, DevToolsGrants } from '../src/background/devtools-grants.ts'

function clock(start = 1_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

describe('DevToolsGrants', () => {
  it('scopes a grant to its kind, session, and origin', () => {
    const grants = new DevToolsGrants(clock().now)
    grants.grant('devtools', 'session-a', 'https://a.example', 7)
    expect(grants.covers('devtools', 'session-a', 'https://a.example')).toBe(true)
    expect(grants.covers('devtools', 'session-b', 'https://a.example')).toBe(false)
    expect(grants.covers('devtools', 'session-a', 'https://b.example')).toBe(false)
    expect(grants.covers('eval', 'session-a', 'https://a.example')).toBe(false)
    expect(grants.covers('devtools', undefined, 'https://a.example')).toBe(false)
  })

  it('treats a missing session as its own scope', () => {
    const grants = new DevToolsGrants(clock().now)
    grants.grant('eval', undefined, 'https://a.example', 1)
    expect(grants.covers('eval', undefined, 'https://a.example')).toBe(true)
    expect(grants.covers('eval', 'session-a', 'https://a.example')).toBe(false)
  })

  it('expires after the TTL, which defaults to 30 minutes', () => {
    expect(DEVTOOLS_GRANT_TTL_MS).toBe(30 * 60 * 1000)
    const time = clock()
    const grants = new DevToolsGrants(time.now)
    grants.grant('devtools', 's', 'https://a.example', 1)
    time.advance(DEVTOOLS_GRANT_TTL_MS - 1)
    expect(grants.covers('devtools', 's', 'https://a.example')).toBe(true)
    time.advance(1)
    expect(grants.covers('devtools', 's', 'https://a.example')).toBe(false)
    expect(grants.hasAny()).toBe(false)
  })

  it('expires when the granted tab navigates away from the origin', () => {
    const grants = new DevToolsGrants(clock().now)
    grants.grant('devtools', 's', 'https://a.example', 1)
    grants.grant('eval', 's', 'https://a.example', 1)
    grants.grant('devtools', 's', 'https://a.example', 2)
    grants.onTopFrameCommit(1, 'https://a.example/next')
    expect(grants.covers('eval', 's', 'https://a.example')).toBe(true)
    grants.onTopFrameCommit(1, 'https://b.example/')
    expect(grants.covers('eval', 's', 'https://a.example')).toBe(false)
    // The same origin granted from another tab stays until that tab leaves.
    expect(grants.covers('devtools', 's', 'https://a.example')).toBe(true)
    grants.onTopFrameCommit(2, 'about:blank')
    expect(grants.covers('devtools', 's', 'https://a.example')).toBe(false)
  })

  it('clears everything at once', () => {
    const grants = new DevToolsGrants(clock().now)
    grants.grant('devtools', 's', 'https://a.example', 1)
    expect(grants.hasAny()).toBe(true)
    grants.clear()
    expect(grants.hasAny()).toBe(false)
  })
})
