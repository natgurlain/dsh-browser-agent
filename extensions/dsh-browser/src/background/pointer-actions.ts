/**
 * Trusted pointer input over CDP: mouse moves, clicks, and drags, plus the
 * frame-aware translation from an element the content script measured to a
 * point in the coordinate space of the CDP target that receives the input.
 *
 * The element is handed over through the content script's isolated-world
 * registry (never a DOM marker the page could observe). Immediately before
 * every press (and before a hover move), the input is re-hit-tested over CDP
 * at the exact point: the topmost node must be the target or inside it, in
 * the target's own frame; anything else (an overlay, a cross-origin iframe the
 * page slid underneath) refuses the gesture.
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

import type { CdpClient, FrameExecutionContext } from './debugger-session.ts'
import { DevToolsError } from './debugger-session.ts'
import type { TabFrame } from './frames.ts'
import { modifierMask, type ModifierName } from './keys.ts'
import { POINTER_REGISTRY_GLOBAL, type ElementPoint } from '../shared/input-setup.ts'

/** Mouse buttons CDP accepts. */
export type MouseButton = 'left' | 'middle' | 'right'

const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 }

/** Where pointer input for one element goes. */
export interface PointerTarget {
  client: CdpClient
  point: ElementPoint
  /**
   * Re-hit-test at `point` over CDP right before input is delivered.
   * @throws {PointerRedirectedError} unless the topmost node is the target or inside it.
   */
  verify(point?: ElementPoint): Promise<void>
}

/** The node under the pointer is not the measured target (the page swapped it at the last moment). */
export class PointerRedirectedError extends Error {
  constructor(readonly hit: string) {
    super(`The pointer would land on ${hit}, not on the target.`)
    this.name = 'PointerRedirectedError'
  }
}

/** Isolated-world expression calling the content script's pointer registry. */
function registryCall(method: 'has' | 'get', token: string): string {
  const global = `globalThis[${JSON.stringify(POINTER_REGISTRY_GLOBAL)}]`
  return `(() => { const r = ${global}; return typeof r === 'object' && r !== null ? r.${method}(${JSON.stringify(token)}) : undefined })()`
}

const REACHES_FUNCTION = `function (token) { const r = globalThis[${JSON.stringify(POINTER_REGISTRY_GLOBAL)}]; return typeof r === 'object' && r !== null && r.reaches(token, this) === true }`

/**
 * The content script's isolated world in the frame that measured `token`:
 * the token is a fresh UUID only that frame's registry holds, so no DOM
 * marker is needed to map the Chrome frame onto a CDP context.
 */
async function registryContext(client: CdpClient, token: string): Promise<FrameExecutionContext> {
  if (client.isolatedContexts === undefined) {
    throw new DevToolsError('devtools-unavailable', 'The browser cannot locate the target element for trusted input.')
  }
  for (const context of await client.isolatedContexts()) {
    const answer = await context.client.send('Runtime.evaluate', {
      expression: registryCall('has', token), uniqueContextId: context.uniqueId, returnByValue: true,
    }).catch(() => undefined) as { result?: { value?: unknown } } | undefined
    if (answer?.result?.value === true) return context
  }
  throw new DevToolsError('devtools-command-failed', 'The target element is no longer in the frame.')
}

/** Short description of a CDP node for a refusal (tag name only, inert). */
async function describeHit(client: CdpClient, backendNodeId: number): Promise<string> {
  try {
    const described = await client.send('DOM.describeNode', { backendNodeId }) as { node?: { nodeName?: unknown } }
    const name = typeof described.node?.nodeName === 'string' ? described.node.nodeName.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) : ''
    return name === '' ? 'another element' : `<${name}>`
  } catch {
    return 'another element'
  }
}

/** CDP hit-test at `point`: the topmost node must be the registry's target or inside it. */
async function verifyHit(context: FrameExecutionContext, token: string, point: ElementPoint): Promise<void> {
  const { client } = context
  await client.send('DOM.enable')
  // getNodeForLocation takes document coordinates of the session's local
  // root; input points are viewport coordinates: add its scroll offset.
  const metrics = await client.send('Page.getLayoutMetrics') as { cssLayoutViewport?: { pageX?: unknown; pageY?: unknown } }
  const scrollX = Number(metrics.cssLayoutViewport?.pageX ?? 0)
  const scrollY = Number(metrics.cssLayoutViewport?.pageY ?? 0)
  if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY)) throw new DevToolsError('devtools-command-failed', 'The browser reported no usable scroll position.')
  const hit = await client.send('DOM.getNodeForLocation', {
    x: Math.round(point.x + scrollX), y: Math.round(point.y + scrollY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false,
  }) as { backendNodeId?: number; frameId?: string }
  if (typeof hit.backendNodeId !== 'number') throw new PointerRedirectedError('nothing')
  // A node in another frame (an iframe slid under the point) is never the target.
  if (hit.frameId !== undefined && hit.frameId !== context.frameId) throw new PointerRedirectedError(await describeHit(client, hit.backendNodeId))
  if (context.id === undefined) throw new DevToolsError('devtools-unavailable', 'The browser cannot verify the pointer target.')
  const resolved = await client.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId, executionContextId: context.id }) as { object?: { objectId?: string } }
  const objectId = resolved.object?.objectId
  if (objectId === undefined) throw new PointerRedirectedError(await describeHit(client, hit.backendNodeId))
  let reaches = false
  try {
    const answer = await client.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: REACHES_FUNCTION, arguments: [{ value: token }], returnByValue: true,
    }) as { result?: { value?: unknown } }
    reaches = answer.result?.value === true
  } finally {
    await client.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
  }
  if (!reaches) throw new PointerRedirectedError(await describeHit(client, hit.backendNodeId))
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
 * Resolve where a measured element is for the CDP target that must receive
 * the input.
 * @param client - the tab's root CDP session.
 * @param _tabId - tab owning the frame.
 * @param frame - frame that owns the element.
 * @param token - the one-time token the content script registered the element under.
 * @param mainFramePoint - the content script's own measurement, used for the main frame.
 */
export async function resolvePointerTarget(
  client: CdpClient,
  _tabId: number,
  frame: TabFrame,
  token: string,
  mainFramePoint: ElementPoint,
): Promise<PointerTarget> {
  const context = await registryContext(client, token)
  const resolved: PointerTarget = {
    client: context.client,
    point: mainFramePoint,
    verify: (point?: ElementPoint): Promise<void> => verifyHit(context, token, point ?? resolved.point),
  }
  if (frame.frameId === 0) return resolved
  await context.client.send('DOM.enable')
  const answer = await context.client.send('Runtime.evaluate', {
    expression: registryCall('get', token),
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
    resolved.point = quadCenter(quad)
    return resolved
  } finally {
    await context.client.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
  }
}

/** Options shared by the gestures. */
export interface PointerOptions {
  modifiers?: readonly ModifierName[]
  /** Re-hit-test right before each press; throws to refuse the gesture. */
  verify?: () => Promise<void>
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
    // After the move (the page may react to mousemove) and before every press.
    await options.verify?.()
    await client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button, buttons: BUTTON_BITS[button], clickCount: count, modifiers,
    })
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: count, modifiers,
    })
  }
}

/**
 * Press at `from`, move to `to` in `steps`, and release there. Once the press
 * went out, a release is always sent (at the last point reached), so a failed
 * move never leaves the page with the button held down.
 * @param verify - re-hit-test of the source right before the press.
 */
export async function mouseDrag(client: CdpClient, from: ElementPoint, to: ElementPoint, steps: number, verify?: () => Promise<void>): Promise<void> {
  const count = Math.max(1, Math.min(60, Math.round(steps)))
  await mouseMove(client, from)
  await verify?.()
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1,
  })
  let at = from
  let released = false
  try {
    for (let step = 1; step <= count; step += 1) {
      const ratio = step / count
      const next = { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio }
      await mouseMove(client, next, { buttons: 1 })
      at = next
    }
    released = true
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
    })
  } finally {
    if (!released) {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1,
      }).catch(() => undefined)
    }
  }
}
