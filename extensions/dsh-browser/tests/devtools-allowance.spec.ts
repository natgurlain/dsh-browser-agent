// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { DEVTOOLS_ALLOWANCE_MS, nextDevToolsAllowance, readDevToolsAllowance } from '../src/background/devtools-allowance'

const NOW = 1_800_000_000_000
const OFF = { allowDevTools: false, allowDevToolsUntil: 0 }

describe('readDevToolsAllowance', () => {
  it('keeps an unexpired allowance', () => {
    expect(readDevToolsAllowance(true, NOW + 60_000, NOW)).toEqual({ allowDevTools: true, allowDevToolsUntil: NOW + 60_000 })
  })

  it('turns an expired allowance off', () => {
    expect(readDevToolsAllowance(true, NOW, NOW)).toEqual(OFF)
    expect(readDevToolsAllowance(true, NOW - 1, NOW)).toEqual(OFF)
  })

  it('turns off an allowance stored before the limit existed', () => {
    expect(readDevToolsAllowance(true, undefined, NOW)).toEqual(OFF)
    expect(readDevToolsAllowance(true, 0, NOW)).toEqual(OFF)
  })

  it('rejects malformed end times', () => {
    for (const until of [Number.POSITIVE_INFINITY, Number.NaN, '9999999999999', null]) {
      expect(readDevToolsAllowance(true, until, NOW)).toEqual(OFF)
    }
  })

  it('clamps an end time further away than one window', () => {
    expect(readDevToolsAllowance(true, NOW + 10 * DEVTOOLS_ALLOWANCE_MS, NOW))
      .toEqual({ allowDevTools: true, allowDevToolsUntil: NOW + DEVTOOLS_ALLOWANCE_MS })
  })

  it('ignores an end time when the flag is off', () => {
    expect(readDevToolsAllowance(false, NOW + 60_000, NOW)).toEqual(OFF)
    expect(readDevToolsAllowance('true', NOW + 60_000, NOW)).toEqual(OFF)
  })
})

describe('nextDevToolsAllowance', () => {
  it('opens a full window when turned on from off', () => {
    expect(nextDevToolsAllowance(OFF, true, NOW)).toEqual({ allowDevTools: true, allowDevToolsUntil: NOW + DEVTOOLS_ALLOWANCE_MS })
  })

  it('turns off on request, whatever was left', () => {
    expect(nextDevToolsAllowance({ allowDevTools: true, allowDevToolsUntil: NOW + 60_000 }, false, NOW)).toEqual(OFF)
  })

  it('does not extend the window when an on setting is saved again', () => {
    const current = { allowDevTools: true, allowDevToolsUntil: NOW + 60_000 }
    expect(nextDevToolsAllowance(current, true, NOW)).toEqual(current)
  })

  it('does not reopen an expired window when an on setting is saved again', () => {
    expect(nextDevToolsAllowance({ allowDevTools: true, allowDevToolsUntil: NOW - 1 }, true, NOW)).toEqual(OFF)
  })

  it('does not reopen a legacy allowance with no end time', () => {
    expect(nextDevToolsAllowance({ allowDevTools: true }, true, NOW)).toEqual(OFF)
  })

  it('expires an allowance on a save that does not touch it', () => {
    expect(nextDevToolsAllowance({ allowDevTools: true, allowDevToolsUntil: NOW - 1 }, undefined, NOW)).toEqual(OFF)
    const live = { allowDevTools: true, allowDevToolsUntil: NOW + 5 }
    expect(nextDevToolsAllowance(live, undefined, NOW)).toEqual(live)
  })
})
