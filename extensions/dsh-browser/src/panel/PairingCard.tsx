import { useState } from 'react'
import type { PanelCopy } from './strings.ts'

/** What the card needs from the panel API. */
export interface PairingApi {
  pair(code: string): Promise<void>
}

/** The failure codes the background reports (`PairingFailure`), read off a rejected {@link PairingApi.pair}. */
export function pairingFailureText(cause: unknown, copy: PanelCopy['pairing']): string {
  const code = (cause as { code?: unknown } | null)?.code
  return typeof code === 'string' && Object.hasOwn(copy.failure, code)
    ? copy.failure[code as keyof PanelCopy['pairing']['failure']]
    : copy.failure.unreachable
}

/**
 * One-step pairing for installs without a bridge token (Web Store, Brave,
 * Firefox): the user types the one-time code their DSH host shows, and the
 * background exchanges it for the token. The code is only ever sent to the
 * background worker, never stored.
 * @param props.needed - show the "not paired yet" lead (the bridge refused or no token exists).
 * @param props.onPaired - called once the token is stored.
 */
export function PairingCard({ api, copy, needed = false, onPaired }: {
  api: PairingApi
  copy: PanelCopy['pairing']
  needed?: boolean
  onPaired?: () => void
}): React.JSX.Element {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async (): Promise<void> => {
    if (busy || code.trim() === '') return
    setBusy(true)
    setOutcome(null)
    try {
      await api.pair(code)
      setCode('')
      setOutcome({ ok: true, text: copy.paired })
      onPaired?.()
    } catch (cause) {
      setOutcome({ ok: false, text: pairingFailureText(cause, copy) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={needed ? 'pairing-card needed' : 'pairing-card'} data-testid="pairing-card">
      <strong>{copy.title}</strong>
      {needed ? <p className="pairing-needed">{copy.needed}</p> : null}
      <p>{copy.help}</p>
      <form className="pairing-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={copy.placeholder}
          aria-label={copy.codeLabel}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={16}
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || code.trim() === ''}>
          {busy ? copy.pairing : copy.pair}
        </button>
      </form>
      <span role="status" aria-live="polite" className={outcome?.ok === false ? 'pairing-status settings-error' : 'pairing-status'}>
        {outcome?.text ?? ''}
      </span>
    </section>
  )
}
