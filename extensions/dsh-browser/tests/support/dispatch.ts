/**
 * Named-option wrapper over the positional `dispatchToolCall`, for suites that
 * dispatch onto a fixed test tab.
 */

import { dispatchToolCall, type ToolAnswer, type ToolCall } from '../../src/background/tools.ts'
import type { ApprovalAuthorization, ApprovalPrompt } from '../../src/security/approval.ts'

type DispatchContext = NonNullable<Parameters<typeof dispatchToolCall>[7]>

export interface DispatchOnTabOptions {
  tab: Pick<chrome.tabs.Tab, 'id' | 'url' | 'title'> & { windowId?: number }
  share?: 'ask' | 'auto' | 'off'
  budget?: { maxItems: number; maxChars: number }
  /** Defaults to approving every card. */
  authorize?: (prompt: ApprovalPrompt) => Promise<ApprovalAuthorization>
  signal?: AbortSignal
  /** Defaults to "the tab is still allowed". */
  stillAllowed?: () => boolean
  /** Dispatch context; `unrestrictedAccess` defaults to false and `followTab` to a no-op. */
  context?: Partial<DispatchContext>
}

/** Standard snapshot budget of the dispatch suites. */
export const TEST_BUDGET = { maxItems: 60, maxChars: 12_000 }

/** Dispatch one call onto `options.tab`. */
export function dispatchOnTab(call: ToolCall, options: DispatchOnTabOptions): Promise<ToolAnswer> {
  return dispatchToolCall(
    call,
    options.share ?? 'auto',
    options.budget ?? TEST_BUDGET,
    options.authorize ?? (async () => 'approved'),
    options.signal,
    options.tab,
    options.stillAllowed ?? (() => true),
    { unrestrictedAccess: false, followTab: async () => undefined, ...options.context },
  )
}
