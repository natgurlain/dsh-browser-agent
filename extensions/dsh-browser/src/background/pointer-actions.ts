/**
 * Trusted pointer input over CDP: mouse moves, clicks, and drags, plus the
 * frame-aware translation from an element marked by the content script to a
 * point in the coordinate space of the CDP target that receives the input.
 *
 * Coordinates: `Input.dispatchMouseEvent` takes CSS pixels relative to the
 * viewport of the target it is sent to. The main frame measures its own
 * elements directly. A subframe's element is resolved in the frame's own
 * execution context (the same routing trusted uploads use) and measured with
 * `DOM.getContentQuads`, which reports quads in the coordinate space of that
 * context's local root — the main frame for same-process iframes, the iframe
 * itself for out-of-process ones — so ancestor offsets, borders, scrolling,
 * and CSS transforms are already applied. The input is then sent to that same
 * session.
 *
 * @module
 */

import type { CdpClient } from './debugger-session.ts'
import { DevToolsError } from './debugger-session.ts'
import { resolveDebuggerFrame } from './debugger-frame.ts'
import type { TabFrame } from './frames.ts'
import { modifierMask, type ModifierName } from './keys.ts'
import type { ElementPoint } from '../shared/input-setup.ts'

/** Mouse buttons CDP accepts. */
export type MouseButton = 'left' | 'middle' | 'right'

const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 }

/** Where pointer input for one element goes. */
export interface PointerTarget {
  client: CdpClient
  point: ElementPoint
}

/** Selector of an element marked by the content script's `measure { mark }`. */
export function pointerSelector(token: string): string {
  return `[data-dsh-pointer="${token.replace(/[^a-zA-Z0-9-]/g, '')}"]`
}

/** Center of a CDP quad (8 numbers, four corners). */
export function quadCenter(quad: readonly number[]): ElementPoint {
  if (quad.length !== 8 || !quad.every(Number.isFinite)) {
    throw new DevToolsError('devtools-command-failed', 'The target element has no usable geometry.')
  }
  return {
    x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
    y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
  }
}

/** The quad with the largest area: a wrapped inline element yields several. */
function largestQuad(quads: readonly (readonly number[])[]): readonly number[] | undefined {
  let best: readonly number[] | undefined
  let bestArea = -1
  for (const quad of quads) {
    if (quad.length !== 8) continue
    let area = 0
    for (let index = 0; index < 4; index += 1) {
      const next = (index + 1) % 4
      area += quad[index * 2]! * quad[next * 2 + 1]! - quad[next * 2]! * quad[index * 2 + 1]!
    }
    area = Math.abs(area) / 2
    if (area > bestArea) {
      bestArea = area
      best = quad
    }
  }
  return best
}

/**
 * Resolve where a marked element is for the CDP target that must receive the
 * input.
 * @param client - the tab's root CDP session.
 * @param tabId - tab owning the frame.
 * @param frame - frame that owns the element.
 * @param token - pointer marker token.
 * @param mainFramePoint - the content script's own measurement, used for the main frame.
 */
export async function resolvePointerTarget(
  client: CdpClient,
  tabId: number,
  frame: TabFrame,
  token: string,
  mainFramePoint: ElementPoint,
): Promise<PointerTarget> {
  if (frame.frameId === 0) return { client, point: mainFramePoint }
  const context = await resolveDebuggerFrame(client, tabId, frame)
  await context.client.send('DOM.enable')
  const answer = await context.client.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(pointerSelector(token))})`,
    uniqueContextId: context.uniqueId,
    returnByValue: false,
  }) as { result?: { objectId?: string }; exceptionDetails?: unknown }
  const objectId = answer.result?.objectId
  if (answer.exceptionDetails !== undefined || objectId === undefined) {
    throw new DevToolsError('devtools-command-failed', 'The target element is no longer in the frame.')
  }
  try {
    const quads = await context.client.send('DOM.getContentQuads', { objectId }) as { quads?: number[][] }
    const quad = largestQuad(quads.quads ?? [])
    if (quad === undefined) throw new DevToolsError('devtools-command-failed', 'The target element is not rendered.')
    return { client: context.client, point: quadCenter(quad) }
  } finally {
    await context.client.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
  }
}

/** Options shared by the gestures. */
export interface PointerOptions {
  modifiers?: readonly ModifierName[]
}

/** Move the mouse to a point (hover). */
export async function mouseMove(client: CdpClient, point: ElementPoint, options: PointerOptions & { buttons?: number } = {}): Promise<void> {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: options.buttons ?? 0,
    modifiers: modifierMask(options.modifiers ?? []),
  })
}

/**
 * Click at a point: move there first (hover handlers and `:hover` styles
 * run as for a real user), then press and release `clicks` times.
 */
export async function mouseClick(
  client: CdpClient,
  point: ElementPoint,
  options: PointerOptions & { button?: MouseButton; clicks?: number } = {},
): Promise<void> {
  const button = options.button ?? 'left'
  const clicks = options.clicks ?? 1
  const modifiers = modifierMask(options.modifiers ?? [])
  await mouseMove(client, point, options)
  for (let count = 1; count <= clicks; count += 1) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button, buttons: BUTTON_BITS[button], clickCount: count, modifiers,
    })
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: count, modifiers,
    })
  }
}

/** Press at `from`, move to `to` in `steps`, and release there. */
export async function mouseDrag(client: CdpClient, from: ElementPoint, to: ElementPoint, steps: number): Promise<void> {
  const count = Math.max(1, Math.min(60, Math.round(steps)))
  await mouseMove(client, from)
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1,
  })
  for (let step = 1; step <= count; step += 1) {
    const ratio = step / count
    await mouseMove(client, { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio }, { buttons: 1 })
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
  })
}
