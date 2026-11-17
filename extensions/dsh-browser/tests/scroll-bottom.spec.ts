// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ConversationFollow, isNearScrollBottom, isScrollUpKey } from '../src/panel/scroll.ts'

describe('isNearScrollBottom', () => {
  it('treats a fully scrolled viewport as near the bottom', () => {
    expect(isNearScrollBottom({ scrollTop: 200, scrollHeight: 500, clientHeight: 300 })).toBe(true)
  })

  it('allows a small slack threshold above the true bottom', () => {
    expect(isNearScrollBottom({ scrollTop: 160, scrollHeight: 500, clientHeight: 300 }, 48)).toBe(true)
    expect(isNearScrollBottom({ scrollTop: 140, scrollHeight: 500, clientHeight: 300 }, 48)).toBe(false)
  })

  it('treats short unscrollable content as near the bottom', () => {
    expect(isNearScrollBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toBe(true)
  })
})

describe('ConversationFollow', () => {
  const at = (scrollTop: number, scrollHeight = 2_000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight })

  it('keeps following when a banner above the thread shrinks the scrollport', () => {
    const follow = new ConversationFollow(() => 0)
    follow.onScroll(at(1_500))
    // The taint line appears: 60 px less room, no scroll by the user.
    expect(follow.onResize(at(1_500, 2_000, 440))).toBe(true)
    expect(follow.isFollowing).toBe(true)
  })

  it('keeps following when layout moves the thread up without the user', () => {
    const follow = new ConversationFollow(() => 0)
    follow.onScroll(at(1_500))
    expect(follow.onScroll(at(1_300))).toEqual({ following: true, pin: true })
  })

  it('stops following only when the user scrolls the thread itself up', () => {
    let now = 1_000
    const follow = new ConversationFollow(() => now)
    follow.onScroll(at(1_500))
    follow.noteUserScroll('up')
    now += 50
    expect(follow.onScroll(at(1_200))).toEqual({ following: false, pin: false })
    // New content does not pull a reader back down.
    expect(follow.onResize(at(1_200, 2_400))).toBe(false)
    // Back at the bottom: following again.
    now += 5_000
    expect(follow.onScroll(at(1_900, 2_400))).toEqual({ following: true, pin: false })
  })

  it('does not count a wheel that a nested scroll area took (the thread did not move)', () => {
    let now = 0
    const follow = new ConversationFollow(() => now)
    follow.onScroll(at(1_500))
    follow.noteUserScroll()
    // The code block scrolled; the thread did not. Later content arrives.
    now += 1_000
    expect(follow.onResize(at(1_500, 2_300))).toBe(true)
    expect(follow.isFollowing).toBe(true)
  })

  it('counts a scrollbar drag', () => {
    const follow = new ConversationFollow(() => 0)
    follow.onScroll(at(1_500))
    follow.setDragging(true)
    expect(follow.onScroll(at(900)).following).toBe(false)
    follow.setDragging(false)
    follow.stick()
    expect(follow.isFollowing).toBe(true)
  })

  it('does not stop following after a downward wheel whose smooth scroll ends above new content', () => {
    let now = 0
    const follow = new ConversationFollow(() => now)
    follow.onScroll(at(1_500))
    follow.noteUserScroll('down')
    now += 50
    // Content grew and was pinned; the wheel's animation then lands a little higher.
    follow.pinned(at(1_800, 2_300))
    expect(follow.onScroll(at(1_700, 2_300))).toEqual({ following: true, pin: true })
  })

  it('treats upward navigation keys as scrolling only outside text fields', () => {
    expect(isScrollUpKey({ key: 'PageUp', shiftKey: false, target: null })).toBe(true)
    expect(isScrollUpKey({ key: ' ', shiftKey: true, target: null })).toBe(true)
    expect(isScrollUpKey({ key: 'PageDown', shiftKey: false, target: null })).toBe(false)
    expect(isScrollUpKey({ key: 'ArrowUp', shiftKey: false, target: { tagName: 'TEXTAREA' } as unknown as EventTarget })).toBe(false)
    expect(isScrollUpKey({ key: 'a', shiftKey: false, target: null })).toBe(false)
  })
})
