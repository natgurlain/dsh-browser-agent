/** Shared panel/background contract for browser action approval. */

import type { UrlAnalysis } from './url-risk.ts'
import type { TargetStates } from '../shared/target-description.ts'

export type ApprovalKind = 'read' | 'action'
/**
 * `trust-eval-session` is sent only from a console-eval card whose
 * "trust JavaScript on <origin> for this session" box is ticked.
 */
export type ApprovalDecision = 'deny' | 'allow-once' | 'always-allow-reads' | 'trust-session' | 'trust-eval-session'
/** Background authorization result; transport failures must not masquerade as a user decision. */
export type ApprovalAuthorization = 'approved' | 'denied' | 'unavailable' | 'timed-out' | 'cancelled'

/**
 * The payload an approval covers, rendered verbatim by the panel. Values are
 * never truncated: the user approves exactly what is shown.
 */
export type ApprovalDetail =
  /** Source code the call runs (browser_console_eval). */
  | { kind: 'code'; value: string }
  /**
   * Text the call types; `masked` starts hidden (sensitive or uninspected field).
   * `label` replaces the default "Text to type" heading (dialog message, prompt answer).
   */
  | { kind: 'text'; value: string; masked: boolean; label?: string }
  /** Local file paths handed to the page. */
  | { kind: 'paths'; values: string[] }
  /** Destination URL, decoded, with suspicious values flagged. */
  | { kind: 'url'; url: UrlAnalysis }
  /** Redaction opt-outs the model requested (argument names). */
  | { kind: 'flags'; values: string[] }
  /** The call's verbatim arguments (JSON), when they decide what the call does. */
  | { kind: 'payload'; value: string }
  /**
   * The rows of a program series ("do the remaining N"): one line per row in
   * a person's words (`label`), with that row's verbatim steps behind it
   * (`payload`, JSON). The panel shows the count and folds the list.
   */
  | { kind: 'rows'; rows: Array<{ label: string; payload: string }> }

/**
 * What the background knew about an action card's call when it raised it,
 * kept for Auto approve's decision (security/auto-review.ts). Never part of
 * the binding (the binding covers the same facts through the target
 * description) and never shown on the card.
 */
export interface ApprovalReviewFacts {
  /** The element(s) as the page reported them when the card was raised. */
  targets?: TargetStates
  /** For browser_type: the content script's sensitivity verdict (undefined: not inspected). */
  typedTargetSensitive?: boolean
  /** Effective http(s) URL of the frame the call acts in. */
  pageUrl?: string
  /** Effective origin of the tab's top page. */
  topOrigin?: string
}

/** A policy decision awaiting a user response. */
export interface ApprovalPrompt {
  kind: ApprovalKind
  action: string
  summary: string
  /**
   * Secondary line under the summary of a call that targets an element: how
   * the call addresses it (index or selector) and the row or section the page
   * shows it in. Plain text; the quoted parts are page-authored.
   */
  targetNote?: string
  /**
   * The step-timeline label for this call ("Click button “Save”"), when its
   * target was found on the page. Not part of the binding.
   */
  stepLabel?: string
  origins: string[]
  /** True only when one stable origin can safely be added to the action allowlist. */
  canTrust: boolean
  /**
   * Marks the high-privilege developer-tools group: the panel renders it as its
   * own consent surface and the background never satisfies it from the origin
   * allowlist or unrestricted access.
   */
  devTools?: true
  /** Full payload shown on the card. */
  details?: ApprovalDetail[]
  /**
   * SHA-256 over tool name, arguments, origins, target document, and (for a
   * call that targets an element) the element's kind and name as the card
   * states them. The background recomputes it before executing, from a fresh
   * look at the page, and refuses on any mismatch.
   */
  binding?: string
  /** Origin a developer-tools session grant from this card would cover. */
  grantOrigin?: string
  /** This call needs its own approval; no setting or session grant covers it. */
  perCallOnly?: true
  /** The destination URL carries a long or high-entropy value: trusted origins do not skip it. */
  urlRisk?: true
  /**
   * An optional browser permission the call needs. The panel requests it from
   * the Allow click (a user gesture); such a card is never skipped.
   */
  permission?: 'downloads'
  /**
   * Site policy or a taint rule demands a fresh decision for this call: no
   * setting, trusted origin, session grant, or unrestricted access skips it.
   * The reasons are shown on the card as a text detail.
   */
  forced?: true
  /**
   * Answerable in the browser only: never forwarded to the Host's approval
   * surface, and a notification can only open it for review. Set on a card
   * whose content (the rows of a program series) only the panel can show.
   */
  browserOnly?: true
  /**
   * The external (MCP) client that asked, for a bridge-owned external
   * session: its self-reported name, sanitized by the bridge. Shown on the
   * card; absent for DSH Agent sessions.
   */
  requester?: string
  /**
   * A dev-loop read of a localhost tab on behalf of a linked DSH coding
   * session (its panel label). Shown on the card; the panel never switches to
   * that session, which the browser cannot prompt.
   */
  devLoopFor?: string
  /**
   * Which rules forced a `forced` card: a site `ask` rule, the taint rules, or
   * both. Absent on cards forced for other reasons (watchers, site drivers,
   * strict mode). Auto approve leaves `site-ask` cards to the user and sends
   * `taint` cards to its reviewer. Not part of the binding.
   */
  forcedBy?: Array<'site-ask' | 'taint'>
  /** Facts for Auto approve's decision (action cards from the page dispatcher only). */
  review?: ApprovalReviewFacts
  /**
   * Auto approve's reviewer looked at this card and left it to the user: the
   * line the card shows, with the reviewer's one-line reason (model text,
   * sanitized and capped). Not part of the binding.
   */
  autoReviewNote?: string
}

/** Correlated request delivered to every open side-panel view. */
export interface ApprovalRequest extends ApprovalPrompt {
  id: string
  /** Agent session that requested the browser operation, when known. */
  sessionId?: string
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'deny'
    || value === 'allow-once'
    || value === 'always-allow-reads'
    || value === 'trust-session'
    || value === 'trust-eval-session'
}
