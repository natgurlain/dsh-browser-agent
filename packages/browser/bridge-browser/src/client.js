/**
 * Browser half of `@natgurlain/dsh-bridge-browser`.
 *
 * When the host plugin is active, this client registers two General-settings
 * rows: the pasteable bridge WebSocket URL, and "Pair a browser", which opens
 * a pairing window on the host and shows its one-time code (pairing-mount.ts).
 * The pairing request goes through dsh's authenticated `/api` channel, the
 * same way every other call of this page does.
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
    const PAIRING_POLL_MS = 1_500
    const LOCALE_NS = 'bridge-browser'
    const STYLE_ID = '@natgurlain/dsh-bridge-browser/BridgeAddressRow'
    const inject = ['slots', 'locale']

    const dictionaries = {
      zh: {
        'bridgeAddress.title': '浏览器桥地址',
        'bridgeAddress.help': '粘贴到扩展的「桥地址」设置；在本机上扩展通常会自动发现，无需填写。',
        'pairing.title': '配对浏览器',
        'pairing.help': '用于从应用商店安装的浏览器扩展：点击开始，然后在扩展的「设置 → 与 DSH 配对」中输入显示的配对码。',
        'pairing.start': '配对浏览器',
        'pairing.restart': '重新生成配对码',
        'pairing.cancel': '取消',
        'pairing.code': '配对码（只能使用一次，剩余 {0}）',
        'pairing.onlyInExtension': '只在扩展自己的面板中输入此配对码，不要输入到任何网页。',
        'pairing.paired': '已配对：{0}',
        'pairing.pairedUnknown': '已配对。',
        'pairing.expired': '配对码已过期，请重新开始。',
        'pairing.attempts': '错误的配对码尝试次数过多，配对已关闭。请稍候再重新开始。',
        'pairing.cancelled': '配对已取消。',
        'pairing.cooldown': '错误尝试过多，请在 {0} 秒后重试。',
        'pairing.unavailable': '当前无法开始配对。',
        'bridgeAddress.copy': '复制',
        'bridgeAddress.copied': '已复制',
        'bridgeAddress.loading': '正在读取…',
        'bridgeAddress.unavailable': '暂时无法读取桥地址',
      },
      en: {
        'bridgeAddress.title': 'Browser bridge address',
        'bridgeAddress.help': 'Paste into the extension\'s Bridge address setting. On this computer the extension normally finds it by itself.',
        'pairing.title': 'Pair a browser',
        'pairing.help': 'For a browser extension installed from a store: start here, then type the code into the extension under Settings → Pair with DSH.',
        'pairing.start': 'Pair a browser',
        'pairing.restart': 'New code',
        'pairing.cancel': 'Cancel',
        'pairing.code': 'Pairing code (works once, {0} left)',
        'pairing.onlyInExtension': 'Type this code only into the extension\'s own panel, never into a web page.',
        'pairing.paired': 'Paired: {0}',
        'pairing.pairedUnknown': 'Paired.',
        'pairing.expired': 'The code expired. Start again for a new one.',
        'pairing.attempts': 'Too many wrong codes were tried, so pairing was closed. Wait a moment, then start again.',
        'pairing.cancelled': 'Pairing cancelled.',
        'pairing.cooldown': 'Too many wrong codes were tried. Try again in {0} s.',
        'pairing.unavailable': 'Pairing cannot be started right now.',
        'bridgeAddress.copy': 'Copy',
        'bridgeAddress.copied': 'Copied',
        'bridgeAddress.loading': 'Loading…',
        'bridgeAddress.unavailable': 'Bridge address unavailable',
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
        '.dshBridgePairCode{flex:none;margin:0;padding:8px 14px;border-radius:10px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:600 20px/28px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:0.12em;user-select:all;-webkit-user-select:all}',
        '.dshBridgePairStatus{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
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
    async function pairingRequest(action) {
      const transport = window.__DSH_TRANSPORT__
      const send = typeof transport?.fetch === 'function' ? transport.fetch : (input, init) => fetch(input, init)
      const response = await send(PAIRING_API_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(5_000),
      })
      let body = null
      try { body = await response.json() } catch { /* not JSON: an auth or routing error page */ }
      return { status: response.status, body }
    }

    function formatRemaining(ms) {
      const seconds = Math.max(0, Math.ceil(ms / 1000))
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    }

    /** `chrome-extension://<id>` → the bare ID; other origins as they are. */
    function pairedLabel(origin) {
      const chrome = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin ?? '')
      return chrome === null ? origin : chrome[1]
    }

    function fill(template, value) {
      return template.replace('{0}', value)
    }

    /**
     * "Pair a browser": opens a pairing window on the host and shows its code
     * until it is used, expires, or is cancelled. The code lives only in this
     * component's state.
     */
    function PairBrowserRow({ t }) {
      // view: idle | open | paired | expired | attempts | cancelled | cooldown | unavailable
      const [view, setView] = React.useState('idle')
      const [code, setCode] = React.useState('')
      const [expiresAt, setExpiresAt] = React.useState(0)
      const [detail, setDetail] = React.useState('')
      const [now, setNow] = React.useState(() => Date.now())
      const [busy, setBusy] = React.useState(false)

      const applyStatus = React.useCallback((status) => {
        if (status?.state === 'paired') {
          setCode('')
          setDetail(pairedLabel(status.origin) ?? '')
          setView('paired')
        } else if (status?.state === 'closed') {
          setCode('')
          setView(status.reason === 'attempts' ? 'attempts' : status.reason === 'cancelled' ? 'cancelled' : 'expired')
        } else if (status?.state === 'idle') {
          // The host restarted: the code that was shown is gone.
          setCode('')
          setView('expired')
        }
      }, [])

      // While a code is shown: tick the countdown and ask the host whether it was used.
      React.useEffect(() => {
        if (view !== 'open') return undefined
        let cancelled = false
        const tick = window.setInterval(() => { setNow(Date.now()) }, 1_000)
        const poll = window.setInterval(() => {
          void pairingRequest('status').then(({ status, body }) => {
            if (cancelled || status !== 200) return
            applyStatus(body?.status)
          }).catch(() => {})
        }, PAIRING_POLL_MS)
        return () => {
          cancelled = true
          window.clearInterval(tick)
          window.clearInterval(poll)
        }
      }, [view, applyStatus])

      const start = React.useCallback(async () => {
        setBusy(true)
        try {
          const { status, body } = await pairingRequest('start')
          if (status === 200 && body?.ok === true && typeof body.code === 'string') {
            setCode(body.code)
            // The host's clock decides; the countdown here is only a display.
            setExpiresAt(Date.now() + (typeof body.ttlMs === 'number' ? body.ttlMs : 0))
            setNow(Date.now())
            setView('open')
          } else if (status === 429 && typeof body?.retryAt === 'number') {
            setDetail(String(Math.max(1, Math.ceil((body.retryAt - Date.now()) / 1000))))
            setView('cooldown')
          } else {
            setView('unavailable')
          }
        } catch {
          setView('unavailable')
        } finally {
          setBusy(false)
        }
      }, [])

      const cancel = React.useCallback(async () => {
        setCode('')
        setView('cancelled')
        try { await pairingRequest('cancel') } catch { /* the window expires by itself */ }
      }, [])

      const message = view === 'paired' ? (detail === '' ? t('pairing.pairedUnknown') : fill(t('pairing.paired'), detail))
        : view === 'expired' ? t('pairing.expired')
        : view === 'attempts' ? t('pairing.attempts')
        : view === 'cancelled' ? t('pairing.cancelled')
        : view === 'cooldown' ? fill(t('pairing.cooldown'), detail)
        : view === 'unavailable' ? t('pairing.unavailable')
        : ''

      return React.createElement(
        'div',
        { className: 'dshBridgeAddressRow dshBridgePairRow' },
        React.createElement('div', { className: 'dshBridgeAddressTitle' }, t('pairing.title')),
        React.createElement('p', { className: 'dshBridgeAddressHelp' }, t('pairing.help')),
        view === 'open'
          ? React.createElement(
            React.Fragment,
            null,
            React.createElement('p', { className: 'dshBridgeAddressHelp' }, fill(t('pairing.code'), formatRemaining(expiresAt - now))),
            React.createElement(
              'div',
              { className: 'dshBridgeAddressBody' },
              React.createElement('code', { className: 'dshBridgePairCode', 'data-testid': 'dsh-pairing-code' }, code),
              React.createElement('button', { type: 'button', className: 'dshBridgeAddressCopy', onClick: () => { void cancel() } }, t('pairing.cancel')),
            ),
            React.createElement('p', { className: 'dshBridgeAddressHelp' }, t('pairing.onlyInExtension')),
          )
          : React.createElement(
            'div',
            { className: 'dshBridgeAddressBody' },
            React.createElement(
              'button',
              { type: 'button', className: 'dshBridgeAddressCopy', disabled: busy, onClick: () => { void start() } },
              view === 'idle' ? t('pairing.start') : t('pairing.restart'),
            ),
            message === '' ? null : React.createElement('span', { className: 'dshBridgePairStatus', role: 'status' }, message),
          ),
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
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
