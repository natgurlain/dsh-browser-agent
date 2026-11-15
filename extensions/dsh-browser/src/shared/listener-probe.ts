/**
 * Protocol between the content script (isolated world) and the page-world
 * listener shim (`src/main-world/listener-shim.ts`).
 *
 * The isolated world cannot see a page's event listeners, `onclick`
 * properties or framework expandos (`__reactProps$…`, `_vei`): they live on
 * the page world's wrappers. The shim can. The two worlds share only the DOM,
 * so the answer travels as DOM events and carries exactly one bit per element:
 *
 * 1. The content script dispatches {@link QUERY_EVENT} on `window` with a
 *    fresh nonce as `detail`.
 * 2. The shim (registered first, at `document_start`) swallows the query and
 *    synchronously dispatches `REPORT_EVENT_PREFIX + nonce` on every element
 *    it considers click-activated.
 * 3. The content script collects the targets of those events.
 *
 * No string, attribute or object from the page world reaches the content
 * script: only "this element was reported". The receiver treats even that as
 * an untrusted hint (see `collectInventory` in `content/extract.ts`).
 *
 * @module
 */

/** Event the content script dispatches on `window`; `detail` is the nonce. */
export const QUERY_EVENT = 'dsh-inventory-query'

/** Prefix of the per-query report event the shim dispatches on each element. */
export const REPORT_EVENT_PREFIX = 'dsh-inventory-report-'

/** Shape of a valid nonce (what the shim accepts as an event-name suffix). */
export const NONCE_PATTERN = /^[a-z0-9]{8,40}$/

/** Upper bound on elements one query may report (enforced on both sides). */
export const MAX_REPORTS = 2_000

/** Event types whose listener makes an element a click target. */
export const ACTIVATION_EVENTS: readonly string[] = [
  'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend',
]
