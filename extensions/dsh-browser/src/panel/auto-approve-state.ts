/**
 * Whether Auto approve is on for one conversation, from the background's
 * state (docs/auto-approve-design.md §6): its explicit choice, else "Start
 * conversations in Auto approve". Kept apart from api.ts so panel tests that
 * mock the API module still get it.
 *
 * @module
 */

import type { AutoReviewState } from './api.ts'

export function autoApproveOnFor(state: AutoReviewState, sessionId: string | null): boolean {
  if (!state.offered || sessionId === null) return false
  // The Setting applies only to side-panel conversations, as in the background.
  return state.sessions[sessionId] ?? (state.startOn && state.panel.includes(sessionId))
}
