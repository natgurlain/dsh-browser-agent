/**
 * Browser half of `@natgurlain/dsh-bridge-browser`.
 *
 * When the host plugin is active, this client registers:
 * - a General-settings row with the pasteable bridge WebSocket URL;
 * - the pairing prompt: when a browser extension asks to connect, a card
 *   "<Browser> wants to connect, code XXX-XXX — Approve / Deny" appears over
 *   the app (and in a General-settings row). The user approves when the code
 *   is the one their browser shows (pairing-mount.ts).
 * Pairing calls go through dsh's authenticated `/api` channel, the same way
 * every other call of this page does.
 */
window.__ModuleLoader__.load({
  id: '@natgurlain/dsh-bridge-browser',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')

    const BRIDGE_PATH = '/ext/bridge'
    const BRIDGE_CONFIG_PATH = '/ext/bridge-config'
    // Document-relative, like dsh's own `/api` calls (the page may be mounted below a prefix).
    const PAIRING_API_ROUTE = 'api/bridge-browser.pairing'
    const PAIRING_POLL_MS = 2_500
    // After a failed poll (an older host, a transport without this route): look again much later.
    const PAIRING_POLL_BACKOFF_MS = 30_000
    const PAIRED_NOTICE_MS = 8_000
    const LOCALE_NS = 'bridge-browser'
    const STYLE_ID = '@natgurlain/dsh-bridge-browser/BridgeAddressRow'
    const inject = ['slots', 'locale']

    const dictionaries = {
      zh: {
        'bridgeAddress.title': '浏览器桥地址',
        'bridgeAddress.help': '粘贴到扩展的「桥地址」设置；在本机上扩展通常会自动发现，无需填写。',
        'pairing.title': '配对浏览器',
        'pairing.idle': '打开浏览器扩展的侧边栏，它会显示一个配对码并在这里请求批准。当前没有浏览器请求连接。',
        'pairing.wants': '{0} 请求连接',
        'pairing.code': '配对码',
        'pairing.compare': '仅当浏览器扩展显示相同的配对码时才批准。',
        'pairing.several': '有多个请求：只批准与你的浏览器显示的配对码相同的那一个，其余请拒绝。',
        'pairing.approve': '批准',
        'pairing.deny': '拒绝',
        'pairing.paired': '已与 {0} 配对。',
        'pairing.gone': '该请求已失效（已过期或浏览器已撤回）。',
      },
      en: {
        'bridgeAddress.title': 'Browser bridge address',
        'bridgeAddress.help': 'Paste into the extension\'s Bridge address setting. On this computer the extension normally finds it by itself.',
        'pairing.title': 'Pair a browser',
        'pairing.idle': 'Open the browser extension\'s side panel: it shows a code and asks here for approval. No browser is asking right now.',
        'pairing.wants': '{0} wants to connect',
        'pairing.code': 'Code',
        'pairing.compare': 'Approve only if the browser extension shows the same code.',
        'pairing.several': 'Several requests: approve only the one whose code your browser shows, and deny the others.',
        'pairing.approve': 'Approve',
        'pairing.deny': 'Deny',
        'pairing.paired': 'Paired with {0}.',
        'pairing.gone': 'That request is no longer waiting (it expired or the browser withdrew it).',
      },
    }

    function bridgeWsUrlFromLocation(location) {
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const hostname = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname
      const host = location.port === '' ? hostname : `${hostname}:${location.port}`
      return `${wsProtocol}//${host}${BRIDGE_PATH}`
    }

    async function resolveBridgeWsUrl(location) {
      const fallback = bridgeWsUrlFromLocation(location)
      try {
        const response = await fetch(`${location.origin}${BRIDGE_CONFIG_PATH}`, {
          signal: AbortSignal.timeout(1_500),
        })
        if (!response.ok) return fallback
        const body = await response.json()
        if (typeof body?.wsUrl === 'string'
          && (body.wsUrl.startsWith('ws://') || body.wsUrl.startsWith('wss://'))) {
          return body.wsUrl
        }
      } catch {
        // Fall through to the reconstructed URL.
      }
      return fallback
    }

    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) {
        return () => {}
      }
      const style = document.createElement('style')
      style.dataset.plugin = '@natgurlain/dsh-bridge-browser'
      style.dataset.pluginCss = STYLE_ID
      style.textContent = [
        '.dshBridgeAddressRow{border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:8px;padding:16px 0}',
        '.dshBridgeAddressTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
        '.dshBridgeAddressHelp{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
        '.dshBridgeAddressBody{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dshBridgeAddressValue{flex:1;min-width:0;margin:0;padding:8px 12px;border-radius:10px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:400 12px/18px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;user-select:all;-webkit-user-select:all;overflow-x:auto;white-space:nowrap}',
        '.dshBridgeAddressCopy{flex:none;height:32px;padding:0 12px;border:none;border-radius:16px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
        '.dshBridgeAddressCopy:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dshBridgeAddressCopy:disabled{cursor:default;opacity:0.6}',
        '.dshBridgePairRequest{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}',
        '.dshBridgePairWho{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
        '.dshBridgePairCode{flex:none;margin:0;padding:4px 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:600 18px/26px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:0.12em}',
        '.dshBridgePairOrigin{flex-basis:100%;color:var(--dsw-alias-label-tertiary);font:400 11px/16px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshBridgePairApprove{flex:none;height:32px;padding:0 14px;border:none;border-radius:16px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base,#fff);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
        '.dshBridgePairStatus{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
        '.dshBridgePairPrompt{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;width:min(360px,calc(100vw - 32px));padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 8px 28px rgba(0,0,0,.18)}',
      ].join('')
      document.head.append(style)
      return () => style.remove()
    }

    function BridgeAddressRow({ t }) {
      const [address, setAddress] = React.useState('')
      const [status, setStatus] = React.useState('loading')
      const [copied, setCopied] = React.useState(false)

      React.useEffect(() => {
        let cancelled = false
        void resolveBridgeWsUrl(window.location).then((url) => {
          if (cancelled) return
          setAddress(url)
          setStatus('ready')
        }).catch(() => {
          if (cancelled) return
          setStatus('error')
        })
        return () => { cancelled = true }
      }, [])

      React.useEffect(() => {
        if (!copied) return undefined
        const timer = window.setTimeout(() => setCopied(false), 1_500)
        return () => window.clearTimeout(timer)
      }, [copied])

      const onCopy = React.useCallback(async () => {
        if (address === '') return
        try {
          await navigator.clipboard.writeText(address)
          setCopied(true)
        } catch {
          const selection = window.getSelection()
          const node = document.querySelector('.dshBridgeAddressValue')
          if (selection !== null && node instanceof HTMLElement) {
            const range = document.createRange()
            range.selectNodeContents(node)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }, [address])

      const value = status === 'loading'
        ? t('bridgeAddress.loading')
        : status === 'error'
          ? t('bridgeAddress.unavailable')
          : address

      return React.createElement(
        'div',
        { className: 'dshBridgeAddressRow' },
        React.createElement('div', { className: 'dshBridgeAddressTitle' }, t('bridgeAddress.title')),
        React.createElement('p', { className: 'dshBridgeAddressHelp' }, t('bridgeAddress.help')),
        React.createElement(
          'div',
          { className: 'dshBridgeAddressBody' },
          React.createElement(
            'code',
            {
              className: 'dshBridgeAddressValue',
              title: address || undefined,
            },
            value,
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dshBridgeAddressCopy',
              disabled: status !== 'ready' || address === '',
              onClick: () => { void onCopy() },
            },
            copied ? t('bridgeAddress.copied') : t('bridgeAddress.copy'),
          ),
        ),
      )
    }

    /** One POST to the pairing control route; resolves to `{ status, body }` or rejects when it is unreachable. */
    async function pairingRequest(payload) {
      const transport = window.__DSH_TRANSPORT__
      const send = typeof transport?.fetch === 'function' ? transport.fetch : (input, init) => fetch(input, init)
      const response = await send(PAIRING_API_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      })
      let body = null
      try { body = await response.json() } catch { /* not JSON: an auth or routing error page */ }
      return { status: response.status, body }
    }

    function fill(template, value) {
      return template.replace('{0}', value)
    }

    /**
     * The pairing requests waiting on the host, kept current by polling, and
     * the two answers. Every mounted prompt runs its own copy; the host is
     * the single source of truth, so they cannot disagree for long.
     */
    function usePairingRequests() {
      const [requests, setRequests] = React.useState([])
      const [notice, setNotice] = React.useState(null)
      const lastPairedAt = React.useRef(null)

      const adopt = React.useCallback((body) => {
        if (!Array.isArray(body?.requests)) return
        setRequests(body.requests.filter(request => typeof request?.id === 'string' && typeof request.code === 'string'))
        const at = typeof body.paired?.at === 'number' ? body.paired.at : null
        // The first answer only records what was already paired before this page looked.
        if (lastPairedAt.current !== null && at !== null && at !== lastPairedAt.current) {
          setNotice({ kind: 'paired', name: String(body.paired.name ?? '') })
        }
        if (at !== null || lastPairedAt.current === null) lastPairedAt.current = at ?? 0
      }, [])

      React.useEffect(() => {
        let stopped = false
        let timer
        const poll = async () => {
          let delay = PAIRING_POLL_MS
          try {
            const { status, body } = await pairingRequest({ action: 'list' })
            if (stopped) return
            if (status === 200) adopt(body)
            else delay = PAIRING_POLL_BACKOFF_MS
          } catch {
            delay = PAIRING_POLL_BACKOFF_MS
          }
          if (!stopped) timer = window.setTimeout(poll, delay)
        }
        void poll()
        return () => {
          stopped = true
          window.clearTimeout(timer)
        }
      }, [adopt])

      React.useEffect(() => {
        if (notice === null) return undefined
        const timer = window.setTimeout(() => setNotice(null), PAIRED_NOTICE_MS)
        return () => window.clearTimeout(timer)
      }, [notice])

      const answer = React.useCallback(async (action, id) => {
        // The request leaves the list at once, so a second click cannot answer it twice.
        setRequests(current => current.filter(request => request.id !== id))
        try {
          const { status, body } = await pairingRequest({ action, id })
          if (status === 200) adopt(body)
          else if (status === 409) {
            setNotice({ kind: 'gone' })
            adopt(body)
          }
        } catch { /* the next poll shows what is true */ }
      }, [adopt])

      return { requests, notice, answer }
    }

    /** "<Browser> wants to connect, code XXX-XXX — Approve / Deny", once per waiting request. */
    function PairingRequestList({ t, requests, notice, answer }) {
      return React.createElement(
        React.Fragment,
        null,
        requests.length > 1
          ? React.createElement('p', { className: 'dshBridgeAddressHelp', role: 'alert' }, t('pairing.several'))
          : null,
        requests.map(request => React.createElement(
          'div',
          { key: request.id, className: 'dshBridgePairRequest', 'data-testid': 'dsh-pairing-request' },
          React.createElement('span', { className: 'dshBridgePairWho' }, fill(t('pairing.wants'), request.name || '?')),
          React.createElement('code', { className: 'dshBridgePairCode', 'aria-label': t('pairing.code'), 'data-testid': 'dsh-pairing-code' }, request.code),
          React.createElement('button', { type: 'button', className: 'dshBridgePairApprove', onClick: () => { void answer('approve', request.id) } }, t('pairing.approve')),
          React.createElement('button', { type: 'button', className: 'dshBridgeAddressCopy', onClick: () => { void answer('deny', request.id) } }, t('pairing.deny')),
          request.origin ? React.createElement('span', { className: 'dshBridgePairOrigin', title: request.origin }, request.origin) : null,
        )),
        requests.length > 0
          ? React.createElement('p', { className: 'dshBridgeAddressHelp' }, t('pairing.compare'))
          : null,
        notice === null
          ? null
          : React.createElement('span', { className: 'dshBridgePairStatus', role: 'status' },
            notice.kind === 'paired' ? fill(t('pairing.paired'), notice.name || '?') : t('pairing.gone')),
      )
    }

    /** A slot may render without a translator (no locale service): fall back to English. */
    function translator(t) {
      return typeof t === 'function' ? t : key => dictionaries.en[key] ?? key
    }

    /** The General-settings row: the same requests, plus where to start when none is waiting. */
    function PairBrowserRow({ t }) {
      const tr = translator(t)
      const state = usePairingRequests()
      return React.createElement(
        'div',
        { className: 'dshBridgeAddressRow dshBridgePairRow' },
        React.createElement('div', { className: 'dshBridgeAddressTitle' }, tr('pairing.title')),
        state.requests.length === 0 && state.notice === null
          ? React.createElement('p', { className: 'dshBridgeAddressHelp' }, tr('pairing.idle'))
          : null,
        React.createElement(PairingRequestList, { t: tr, ...state }),
      )
    }

    /** The prompt over the app: nothing until a browser asks, then the request with Approve / Deny. */
    function PairingPrompt({ t }) {
      const tr = translator(t)
      const state = usePairingRequests()
      if (state.requests.length === 0 && state.notice === null) return null
      return React.createElement(
        'div',
        { className: 'dshBridgePairPrompt', role: 'dialog', 'aria-label': tr('pairing.title'), 'data-testid': 'dsh-pairing-prompt' },
        React.createElement('div', { className: 'dshBridgeAddressTitle' }, tr('pairing.title')),
        React.createElement(PairingRequestList, { t: tr, ...state }),
      )
    }

    function apply(ctx) {
      ctx.effect(() => installStyle(), 'bridge-browser: settings row styles')
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, dictionaries),
        'bridge-browser: settings dictionaries',
      )
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'bridge-browser-address',
        order: 100,
        locale: LOCALE_NS,
      }, BridgeAddressRow))
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'bridge-browser-pairing',
        order: 101,
        locale: LOCALE_NS,
      }, PairBrowserRow))
      // Over the whole app, so the user does not have to find Settings first.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'bridge-browser-pairing-prompt',
        locale: LOCALE_NS,
      }, PairingPrompt))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
