import { useEffect, useRef, useState } from 'react'
import type { PanelCopy } from './strings.ts'

/** What the card needs from the panel API. */
export interface PairingApi {
  pair(onCode: (code: string) => void): Promise<void>
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
  | { kind: 'asking' }
  | { kind: 'code'; code: string }
  | { kind: 'paired' }
  | { kind: 'failed'; text: string }

/**
 * One-step pairing for installs without a bridge token (Web Store, Brave,
 * Firefox). The extension asks the local DSH host and shows a short code; the
 * user approves in DSH, where the same code is shown. Nothing is typed.
 * @param props.needed - the install cannot authenticate: say so above the card.
 * @param props.autoStart - ask as soon as the card appears instead of waiting for a click.
 * @param props.onPaired - called once the token is stored.
 */
export function PairingCard({ api, copy, needed = false, autoStart = false, onPaired }: {
  api: PairingApi
  copy: PanelCopy['pairing']
  needed?: boolean
  autoStart?: boolean
  onPaired?: () => void
}): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'idle' })
  // The request in flight; a late answer for an older one is ignored.
  const run = useRef(0)

  const ask = (): void => {
    const current = ++run.current
    setView({ kind: 'asking' })
    void api.pair((code) => { if (run.current === current) setView({ kind: 'code', code }) }).then(() => {
      if (run.current !== current) return
      setView({ kind: 'paired' })
      onPaired?.()
    }, (cause: unknown) => {
      if (run.current === current) setView({ kind: 'failed', text: pairingFailureText(cause, copy) })
    })
  }

  // An install that cannot connect asks as soon as the card appears: the
  // user's first step is then to look at the code, not to find a button.
  // Leaving the card withdraws a request that is still waiting.
  useEffect(() => {
    if (autoStart) ask()
    return () => {
      run.current += 1
      void api.cancelPairing().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, [])

  return (
    <section className={needed ? 'pairing-card needed' : 'pairing-card'} data-testid="pairing-card">
      <strong>{copy.title}</strong>
      {needed ? <p className="pairing-needed">{copy.needed}</p> : null}
      {view.kind === 'code' ? (
        <>
          <output className="pairing-code" aria-label={copy.codeLabel} data-testid="pairing-code">{view.code}</output>
          <p className="pairing-approve">{copy.approve}</p>
          <p>{copy.approveHelp}</p>
        </>
      ) : view.kind === 'asking' ? (
        <p role="status">{copy.asking}</p>
      ) : (
        <>
          {view.kind === 'idle' ? <p>{copy.help}</p> : null}
          <span role="status" aria-live="polite" className={view.kind === 'failed' ? 'pairing-status settings-error' : 'pairing-status'}>
            {view.kind === 'failed' ? view.text : view.kind === 'paired' ? copy.paired : ''}
          </span>
          {view.kind === 'paired' ? null : (
            <button type="button" className="primary pairing-start" onClick={ask}>
              {view.kind === 'failed' ? copy.retry : copy.start}
            </button>
          )}
        </>
      )}
    </section>
  )
}
