import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AUDIT_GENESIS_HASH,
  AUDIT_KEY_FILE,
  AuditLog,
  auditEntryHash,
  ToolCallAuditor,
  auditFileName,
  canonicalJson,
  maskAuditArgs,
  parseAuditLines,
  redactAuditUrl,
  verifyAuditChain,
} from '../src/audit-log.ts'
import { tempDirs } from './support/tmp.ts'

const tempDir = tempDirs('dsh-audit-')
const temp = (): string => join(tempDir(), 'browser-audit')

describe('audit log chain', () => {
  it('appends hash-chained entries per session into private files', async () => {
    const dir = temp()
    const log = new AuditLog(dir, () => Date.UTC(2026, 0, 1))
    await log.append('session-1', { kind: 'tool-call', tool: 'browser_click', callId: 'a' })
    await log.append('session-1', { kind: 'result', tool: 'browser_click', callId: 'a', outcome: 'ok', durationMs: 5 })
    await log.append(undefined, { kind: 'kill-switch', decision: 'engaged' })
    const exported = await log.read('session-1')
    expect(exported.verification).toEqual({ ok: true, count: 2 })
    const [first, second] = exported.entries as Array<Record<string, unknown>>
    expect(first).toMatchObject({ seq: 1, prevHash: AUDIT_GENESIS_HASH, kind: 'tool-call', sessionId: 'session-1', ts: '2026-01-01T00:00:00.000Z' })
    expect(second).toMatchObject({ seq: 2, prevHash: first!.hash, kind: 'result' })
    expect((await log.read(undefined)).entries).toHaveLength(1)
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(log.file('session-1')).mode & 0o777).toBe(0o600)
    }
  })

  it('continues an existing chain after a restart', async () => {
    const dir = temp()
    await new AuditLog(dir).append('s', { kind: 'tool-call' })
    await new AuditLog(dir).append('s', { kind: 'result' })
    const exported = await new AuditLog(dir).read('s')
    expect(exported.verification.ok).toBe(true)
    expect(exported.entries.map((entry) => (entry as { seq: number }).seq)).toEqual([1, 2])
  })

  it('serializes concurrent appends', async () => {
    const log = new AuditLog(temp())
    await Promise.all(Array.from({ length: 20 }, (_, index) => log.append('s', { kind: 'tool-call', callId: String(index) })))
    const exported = await log.read('s')
    expect(exported.verification).toEqual({ ok: true, count: 20 })
  })

  it('detects edited, dropped, reordered, and corrupted lines', async () => {
    const log = new AuditLog(temp())
    for (const callId of ['a', 'b', 'c']) await log.append('s', { kind: 'tool-call', callId })
    const lines = readFileSync(log.file('s'), 'utf8').trim().split('\n')
    const entries = parseAuditLines(lines.join('\n'))
    const key = await log.chainKey()
    expect(verifyAuditChain(entries, key).ok).toBe(true)
    // Keyed entries do not verify without the key.
    expect(verifyAuditChain(entries).ok).toBe(false)

    const edited = entries.map((entry, index) => index === 1 ? { ...(entry as object), callId: 'forged' } : entry)
    expect(verifyAuditChain(edited, key)).toMatchObject({ ok: false, brokenAt: 1, reason: expect.stringContaining('hash') })
    expect(verifyAuditChain([entries[0], entries[2]], key)).toMatchObject({ ok: false, brokenAt: 1 })
    expect(verifyAuditChain([entries[1], entries[0]], key)).toMatchObject({ ok: false, brokenAt: 0 })
    expect(verifyAuditChain(parseAuditLines(`${lines[0]}\n{oops\n`), key)).toMatchObject({ ok: false, brokenAt: 1 })

    writeFileSync(log.file('s'), `${lines[0]}\n${lines[2]}\n`)
    expect((await new AuditLog(join(log.directory)).read('s')).verification.ok).toBe(false)
  })

  it('keeps unsafe session ids out of the path', () => {
    expect(auditFileName('abc-123')).toBe('s-abc-123.jsonl')
    expect(auditFileName('../../etc/passwd')).toMatch(/^h-[0-9a-f]{40}\.jsonl$/u)
    expect(auditFileName(undefined)).toBe('unscoped.jsonl')
  })

  it('hashes canonical JSON independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}')
  })

  it('keeps an own "__proto__" member, so two entries that differ only there never hash alike', () => {
    const plain = JSON.parse('{"selector":"#a"}') as unknown
    const extra = JSON.parse('{"selector":"#a","__proto__":{"index":4}}') as unknown
    expect(canonicalJson(extra)).toBe('{"__proto__":{"index":4},"selector":"#a"}')
    expect(canonicalJson(extra)).not.toBe(canonicalJson(plain))
  })
})

describe('keyed audit chain (P2 hardening)', () => {
  it('detects a tail truncation (poc5)', async () => {
    const dir = temp()
    const log = new AuditLog(dir)
    await log.append('s1', { kind: 'tool-call', tool: 'browser_snapshot' })
    await log.append('s1', { kind: 'tool-call', tool: 'browser_type', url: 'https://evil.example/' })
    await log.append('s1', { kind: 'result', tool: 'browser_type', outcome: 'ok' })
    const lines = readFileSync(log.file('s1'), 'utf8').trim().split('\n')
    writeFileSync(log.file('s1'), `${lines[0]}\n`)
    const out = await new AuditLog(dir).read('s1')
    expect(out.verification).toMatchObject({ ok: false, reason: expect.stringMatching(/truncated|rewritten/u) })
    // A later append after the truncation must not paper over it.
    await new AuditLog(dir).append('s1', { kind: 'tool-call', tool: 'browser_click' })
    expect((await new AuditLog(dir).read('s1')).verification.ok).toBe(false)
  })

  it('rejects a full downgrade: alg stripped, re-hashed publicly, head deleted, key still present (poc5)', async () => {
    const dir = temp()
    const log = new AuditLog(dir)
    await log.append('s1', { kind: 'tool-call', tool: 'browser_type', url: 'https://evil.example/' })
    await log.append('s1', { kind: 'result', tool: 'browser_type', outcome: 'ok' })
    const lines = readFileSync(log.file('s1'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    let prev = AUDIT_GENESIS_HASH
    const forged = lines.map((entry, index) => {
      const { hash: _hash, alg: _alg, ...rest } = entry
      const body = { ...rest, ...(index === 0 ? { tool: 'browser_scroll', url: undefined } : {}), prevHash: prev }
      const hash = auditEntryHash(body)
      prev = hash
      return JSON.stringify({ ...body, hash })
    })
    writeFileSync(log.file('s1'), `${forged.join('\n')}\n`)
    rmSync(`${log.file('s1')}.head`)
    expect(statSync(join(dir, AUDIT_KEY_FILE)).isFile()).toBe(true)
    const verification = (await new AuditLog(dir).read('s1')).verification
    expect(verification).toMatchObject({ ok: false, reason: expect.stringMatching(/unkeyed/u) })
    expect(verification).not.toHaveProperty('unkeyed')
  })

  it('reports a deleted head anchor and an unknown alg', async () => {
    const dir = temp()
    const log = new AuditLog(dir)
    await log.append('s1', { kind: 'tool-call' })
    await log.append('s1', { kind: 'result' })
    rmSync(`${log.file('s1')}.head`)
    expect((await new AuditLog(dir).read('s1')).verification).toMatchObject({ ok: false, reason: expect.stringMatching(/head anchor is missing/u) })
    const entries = parseAuditLines(readFileSync(log.file('s1'), 'utf8'))
    const key = await log.chainKey()
    const relabelled = entries.map((entry, index) => index === 1 ? { ...(entry as object), alg: 'sha1' } : entry)
    expect(verifyAuditChain(relabelled, key)).toMatchObject({ ok: false, brokenAt: 1, reason: expect.stringMatching(/unknown alg/u) })
  })

  it('rejects an unkeyed entry after keyed ones', async () => {
    const log = new AuditLog(temp())
    await log.append('s1', { kind: 'tool-call' })
    await log.append('s1', { kind: 'result' })
    const key = await log.chainKey()
    const entries = parseAuditLines(readFileSync(log.file('s1'), 'utf8')) as Array<Record<string, unknown>>
    const body = { seq: 3, ts: 't', kind: 'tool-call', prevHash: entries[1]!.hash }
    const unkeyed = { ...body, hash: auditEntryHash(body) }
    expect(verifyAuditChain([...entries, unkeyed], key)).toMatchObject({ ok: false, brokenAt: 2, reason: expect.stringMatching(/unkeyed entry after keyed/u) })
  })

  it('detects a rewrite re-hashed with the public hash function (poc5)', async () => {
    const dir = temp()
    const log = new AuditLog(dir)
    await log.append('s1', { kind: 'tool-call', tool: 'browser_snapshot' })
    await log.append('s1', { kind: 'tool-call', tool: 'browser_type', url: 'https://evil.example/' })
    await log.append('s1', { kind: 'result', tool: 'browser_type', outcome: 'ok' })
    const lines = readFileSync(log.file('s1'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    let prev = AUDIT_GENESIS_HASH
    const forged = [lines[0], { ...lines[1], tool: 'browser_scroll', url: undefined }, lines[2]].map((entry, index) => {
      const { hash: _hash, ...body } = { ...entry, seq: index + 1, prevHash: prev }
      const hash = auditEntryHash(body)
      prev = hash
      return JSON.stringify({ ...body, hash })
    })
    writeFileSync(log.file('s1'), `${forged.join('\n')}\n`)
    expect((await new AuditLog(dir).read('s1')).verification.ok).toBe(false)
  })

  it('keeps legacy unkeyed logs readable: verified while no chain key exists, refused once one does', async () => {
    const dir = temp()
    let prev = AUDIT_GENESIS_HASH
    const legacy = [1, 2].map((seq) => {
      const body = { seq, ts: 't', kind: 'tool-call', prevHash: prev }
      const hash = auditEntryHash(body)
      prev = hash
      return JSON.stringify({ ...body, hash })
    })
    const log = new AuditLog(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(log.file('legacy'), `${legacy.join('\n')}\n`)
    expect((await log.read('legacy')).verification).toEqual({ ok: true, count: 2, unkeyed: true })
    // Once the bridge holds a chain key, an all-unkeyed chain is indistinguishable
    // from a downgraded keyed one: still exported, but not verified.
    await log.append('other', { kind: 'tool-call' })
    const refused = await log.read('legacy')
    expect(refused.entries).toHaveLength(2)
    expect(refused.verification).toMatchObject({ ok: false, reason: expect.stringMatching(/unkeyed/u) })
    // Continuing a legacy file switches to keyed entries and stays verifiable.
    await log.append('legacy', { kind: 'result' })
    expect((await new AuditLog(dir).read('legacy')).verification).toEqual({ ok: true, count: 3 })
  })

  it('keeps the chain key private', async () => {
    const dir = temp()
    const log = new AuditLog(dir)
    await log.append('s', { kind: 'tool-call' })
    if (process.platform !== 'win32') expect(statSync(join(dir, AUDIT_KEY_FILE)).mode & 0o777).toBe(0o600)
  })
})

describe('audit masking', () => {
  it('masks clipboard html and printable or trusted key presses (poc1 §4)', () => {
    const masked = maskAuditArgs({ action: 'write', text: 'secret-text', html: '<b>card 4111 1111 1111 1111</b>' })
    expect(JSON.stringify(masked)).not.toMatch(/4111|secret/u)
    expect(maskAuditArgs({ key: 'h', trusted: true })).toEqual({ key: { masked: true, length: 1 }, trusted: true })
    expect(maskAuditArgs({ key: 'h' })).toEqual({ key: { masked: true, length: 1 } })
    expect(maskAuditArgs({ key: 'Enter' })).toEqual({ key: 'Enter' })
    expect(maskAuditArgs({ key: 'Tab', trusted: true })).toEqual({ key: { masked: true, length: 3 }, trusted: true })
  })

  it('never keeps typed text, dialog answers, code, or upload paths', () => {
    const masked = maskAuditArgs({
      index: 7,
      text: 'hunter2',
      promptText: 'answer',
      expression: 'document.cookie',
      paths: ['/home/me/secret.pdf'],
      selector: '#login',
    })
    expect(masked).toEqual({
      index: 7,
      text: { masked: true, length: 7 },
      promptText: { masked: true, length: 6 },
      expression: { masked: true, length: 15 },
      paths: { masked: true, items: 1 },
      selector: '#login',
    })
    expect(JSON.stringify(masked)).not.toMatch(/hunter2|cookie|secret\.pdf/u)
  })

  it('redacts URLs quoted inside error messages and argument text', async () => {
    const log = new AuditLog(temp())
    const auditor = new ToolCallAuditor(log)
    auditor.dispatched({ id: 'n', name: 'browser_navigate', args: { note: 'go to https://a.test/cb?access_token=SECRETTOKEN now' }, sessionId: 's' })
    auditor.settled('n', { ok: false, error: { code: 'action-failed', message: 'The user denied the browser approval request for "Open https://a.test/cb?access_token=SECRETTOKEN&page=2".' } })
    expect((await log.read('s')).verification.ok).toBe(true)
    const raw = readFileSync(log.file('s'), 'utf8')
    expect(raw).not.toContain('SECRETTOKEN')
    expect(raw).toContain('page=2')
    expect(raw).toContain('access_token=%5Bredacted%5D&page=2\\".')
  })

  it('redacts credentials and risky URL parameters but keeps the shape', () => {
    expect(redactAuditUrl('https://user:pw@example.com/cb?code=abc&page=2&access_token=xyz#id_token=t'))
      .toBe('https://example.com/cb?code=%5Bredacted%5D&page=2&access_token=%5Bredacted%5D#id_token=%5Bredacted%5D')
    expect(redactAuditUrl('https://example.com/reset/QWxhZGRpbjpvcGVuIHNlc2FtZWFsYWRkaW4xMjM0NTY3ODkw'))
      .toBe('https://example.com/reset/[redacted]')
    expect(redactAuditUrl('not a url')).toBe('[redacted]')
    expect(maskAuditArgs({ url: 'https://a.test/?token=1' })).toEqual({ url: 'https://a.test/?token=%5Bredacted%5D' })
  })
})

describe('ToolCallAuditor', () => {
  it('records call, approval, navigation, and result with the model call id', async () => {
    const log = new AuditLog(temp())
    let now = 1_000
    const auditor = new ToolCallAuditor(log, undefined, () => now)
    auditor.dispatched({ id: 'b1', name: 'browser_type', args: { index: 3, text: 'p@ss' }, sessionId: 's', toolCallId: 'toolu_1', connection: 'install-a' })
    auditor.annotated('b1', { decision: 'allowed', url: 'https://shop.test/login?session=abc' })
    auditor.annotated('b1', { decision: 'not-required', navigatedTo: 'https://shop.test/home' })
    now = 1_250
    auditor.settled('b1', { ok: true, result: { text: 'typed' } })
    auditor.settled('b1', { ok: true, result: {} })
    auditor.annotated('unknown', { decision: 'denied' })
    const exported = await log.read('s')
    expect(exported.verification.ok).toBe(true)
    const entries = exported.entries as Array<Record<string, unknown>>
    expect(entries.map((entry) => entry.kind)).toEqual(['tool-call', 'approval', 'navigation', 'result'])
    expect(entries.every((entry) => entry.toolCallId === 'toolu_1' && entry.callId === 'b1')).toBe(true)
    expect(entries[0]).toMatchObject({ connection: 'install-a', tool: 'browser_type', args: { index: 3, text: { masked: true, length: 4 } } })
    expect(entries[1]).toMatchObject({ decision: 'allowed', origin: 'https://shop.test', url: 'https://shop.test/login?session=%5Bredacted%5D' })
    expect(entries[2]).toMatchObject({ url: 'https://shop.test/home' })
    expect(entries[3]).toMatchObject({ decision: 'not-required', outcome: 'ok', durationMs: 250, resultDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}:\d+$/u) })
    expect(JSON.stringify(entries)).not.toContain('p@ss')
  })

  it('records policy, taint, and strict-mode decisions on the approval and result entries', async () => {
    const log = new AuditLog(temp())
    const auditor = new ToolCallAuditor(log)
    auditor.dispatched({ id: 'p', name: 'browser_click', args: { index: 1 }, sessionId: 's', toolCallId: 't' })
    auditor.annotated('p', { decision: 'not-required', policy: 'blocked', policyReason: 'https://bank.test/?sid=abc is blocked', strict: 'refused', commit: ['denied'] })
    auditor.settled('p', { ok: false, error: { code: 'action-failed', message: 'blocked' } })
    const entries = (await log.read('s')).entries as Array<Record<string, unknown>>
    expect(entries.map((entry) => entry.kind)).toEqual(['tool-call', 'approval', 'result'])
    expect(entries[1]).toMatchObject({ policy: 'blocked', strictMode: 'refused', commitDecisions: ['denied'], policyReason: 'https://bank.test/?sid=%5Bredacted%5D is blocked' })
    expect(entries[2]).toMatchObject({ policy: 'blocked', strictMode: 'refused', outcome: 'error' })
  })

  it('records failures and the kill switch for every session with calls in flight', async () => {
    const log = new AuditLog(temp())
    const auditor = new ToolCallAuditor(log)
    auditor.dispatched({ id: 'x', name: 'browser_click', args: {}, sessionId: 'a' })
    auditor.killSwitch()
    auditor.settled('x', { ok: false, error: { code: 'bridge-closed', message: 'cancelled' } })
    // Nothing in flight: the kill switch lands in the unscoped log.
    auditor.killSwitch()
    expect(((await log.read('a')).entries as Array<{ kind: string }>).map((entry) => entry.kind))
      .toEqual(['tool-call', 'kill-switch', 'result'])
    expect(((await log.read(undefined)).entries as Array<{ kind: string }>).map((entry) => entry.kind)).toEqual(['kill-switch'])
  })

  it('reports write failures without throwing into the tool call', async () => {
    const onError = vi.fn()
    const blocked = join(temp(), 'file')
    const parent = join(blocked, '..')
    rmSync(parent, { recursive: true, force: true })
    writeFileSync(parent, 'not a directory')
    const auditor = new ToolCallAuditor(new AuditLog(join(parent, 'sub')), onError)
    expect(() => auditor.dispatched({ id: 'x', name: 'browser_click', args: {} })).not.toThrow()
    await vi.waitFor(() => { expect(onError).toHaveBeenCalled() })
  })
})

describe('kill switch RPC', () => {
  it('revokes standing grants through onKillSwitch (review finding 6)', async () => {
    const onKillSwitch = vi.fn()
    const { handleAuditRpc } = await import('../src/audit-rpc.ts')
    const { BRIDGE_AUDIT_RECORD_METHOD } = await import('../src/protocol.ts')
    expect(await handleAuditRpc(BRIDGE_AUDIT_RECORD_METHOD, { event: 'kill-switch' }, { connection: 'c1', onKillSwitch })).toMatchObject({ ok: true })
    expect(onKillSwitch).toHaveBeenCalledWith('c1')
  })
})
