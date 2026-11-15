import { useEffect, useRef, useState } from 'react'
import type { PanelCopy } from './strings.ts'

/** What the card needs from the panel API. */
export interface PairingApi {
  pair(onCode: (code: string) => void, options?: { again?: boolean }): Promise<void>
  cancelPairing(): Promise<void>
}

/** The failure codes the background reports (`PairingFailure`), read off a rejected {@link PairingApi.pair}. */
export function pairingFailureText(cause: unknown, copy: PanelCopy['pairing']): string {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' && Object.hasOwn(copy.failure, code)
    ? copy.failure[code as keyof PanelCopy['pairing']['failure']]
    : copy.failure.unreachable
}

type View =
  | { kind: 'idle' }
  | { kind: 'confirm-again' }
  | { kind: 'asking' }
  | { kind: 'code'; code: string }
  | { kind: 'paired' }
  | { kind: 'failed'; text: string }

/**
 * One-step pairing for installs without a bridge token (Web Store, Brave,
 * Firefox). The extension shows a short code; the user types it into DSH.
 *
 * @param props.mode - `first`: this install has never held a token; it may
 *   ask by itself (`autoStart`). `again`: it holds one (the connection is
 *   failing for some other reason), so nothing is asked without an explicit
 *   "Pair again…" and a confirmation that says when that is the right thing to do.
 * @param props.needed - say above the card that this browser is not connected.
 * @param props.autoStart - with `first`: ask as soon as the card appears.
 * @param props.titled - false inside a settings group that already carries the title.
 * @param props.onPaired - called once the token is stored.
 */
export function PairingCard({ api, copy, mode, needed = false, autoStart = false, titled = true, onPaired }: {
  api: PairingApi
  copy: PanelCopy['pairing']
  mode: 'first' | 'again'
  needed?: boolean
  autoStart?: boolean
  titled?: boolean
  onPaired?: () => void
}): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'idle' })
  // The request in flight; a late answer for an older one is ignored.
  const run = useRef(0)
  const again = mode === 'again'

  const ask = (): void => {
    const current = ++run.current
    setView({ kind: 'asking' })
    void api.pair((code) => { if (run.current === current) setView({ kind: 'code', code }) }, again ? { again: true } : {}).then(() => {
      if (run.current !== current) return
      setView({ kind: 'paired' })
      onPaired?.()
    }, (cause: unknown) => {
      if (run.current === current) setView({ kind: 'failed', text: pairingFailureText(cause, copy) })
    })
  }

  // A first-time install asks as soon as the card appears: the user's first
  // step is then to read the code, not to find a button. Leaving the card
  // withdraws a request that is still waiting.
  useEffect(() => {
    if (autoStart && !again) ask()
    return () => {
      run.current += 1
      void api.cancelPairing().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, [])

  return (
    <section className={needed ? 'pairing-card needed' : 'pairing-card'} data-testid="pairing-card">
      {titled ? <strong>{copy.title}</strong> : null}
      {needed && !again ? <p className="pairing-needed">{copy.needed}</p> : null}
      {view.kind === 'code' ? (
        <>
          <output className="pairing-code" aria-label={copy.codeLabel} data-testid="pairing-code">{view.code}</output>
          <p className="pairing-enter">{copy.enter}</p>
          <p>{copy.enterHelp}</p>
        </>
      ) : view.kind === 'asking' ? (
        <p role="status">{copy.asking}</p>
      ) : view.kind === 'confirm-again' ? (
        <>
          <p className="pairing-warning" role="alert">{copy.againWarning}</p>
          <div className="pairing-actions">
            <button type="button" className="secondary" onClick={() => setView({ kind: 'idle' })}>{copy.cancel}</button>
            <button type="button" className="primary" onClick={ask}>{copy.againConfirm}</button>
          </div>
        </>
      ) : (
        <>
          {view.kind === 'idle' ? <p>{again ? copy.againHelp : copy.help}</p> : null}
          <span role="status" aria-live="polite" className={view.kind === 'failed' ? 'pairing-status settings-error' : 'pairing-status'}>
            {view.kind === 'failed' ? view.text : view.kind === 'paired' ? copy.paired : ''}
          </span>
          {view.kind === 'paired' ? null : (
            <button type="button" className={again ? 'secondary pairing-start' : 'primary pairing-start'}
              onClick={again ? () => setView({ kind: 'confirm-again' }) : ask}>
              {again ? copy.again : view.kind === 'failed' ? copy.retry : copy.start}
            </button>
          )}
        </>
      )}
    </section>
  )
}
