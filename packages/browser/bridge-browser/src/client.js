/**
 * Browser half of `@natgurlain/dsh-bridge-browser`.
 *
 * When the host plugin is active, this client registers:
 * - a General-settings row with the pasteable bridge WebSocket URL;
 * - pairing: when a browser extension asks to connect, a card "A browser wants
 *   to connect — enter the code it shows" appears over the app, with one
 *   input. The same input is in a General-settings row, with Pause/Resume and
 *   the list of paired extensions (pairing-mount.ts).
 * This page never shows a pairing code: the code exists only in the
 * extension's panel and in what the user types here. Pairing calls go through
 * dsh's authenticated `/api` channel, like every other call of this page.
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
    // After a failed poll (a transport hiccup, an expired session): look again much later.
    const PAIRING_POLL_BACKOFF_MS = 30_000
    const PAIRING_NOTICE_MS = 10_000
    const LOCALE_NS = 'bridge-browser'
    const STYLE_ID = '@natgurlain/dsh-bridge-browser/BridgeAddressRow'
    const inject = ['slots', 'locale']

    const dictionaries = {
      en: {
        'bridgeAddress.title': 'Browser bridge address',
        'bridgeAddress.help': 'Paste into the Chrome extension Bridge address setting. Loopback needs no token.',
        'bridgeAddress.copy': 'Copy',
        'bridgeAddress.copied': 'Copied',
        'bridgeAddress.loading': 'Loading…',
        'bridgeAddress.unavailable': 'Bridge address unavailable',
        'pairing.title': 'Pair a browser',
        'pairing.wants': 'A browser wants to connect',
        'pairing.prompt': 'Enter the code it shows',
        'pairing.official': 'dsh Browser Agent (official)',
        'pairing.unknown': 'Unknown extension {0} — not the published DSH extension',
        'pairing.unknownWarning': 'Enter a code for an unknown extension only if you installed it yourself and trust it: it will be able to drive DSH.',
        'pairing.says': 'says it is {0}',
        'pairing.only': 'Enter a code only when you opened the DSH browser extension yourself and it shows the code.',
        'pairing.placeholder': 'ABC-DEF',
        'pairing.connect': 'Connect',
        'pairing.checking': 'Checking…',
        'pairing.waiting': 'Browsers waiting for a code: {0}. Enter the code your browser shows.',
        'pairing.idle': 'Open the DSH browser extension: its panel shows a six-character code. Enter that code here.',
        'pairing.result.paired': 'Paired with {0}. The browser connects by itself now.',
        'pairing.result.unconfirmed': 'The code matched, but the browser did not confirm. If its panel does not connect, ask again from the browser.',
        'pairing.result.no-match': 'No waiting browser shows that code. A code works for one try: in the browser, choose Ask again and enter the new code.',
        'pairing.result.none-waiting': 'No browser is waiting. Open the DSH browser extension first.',
        'pairing.result.invalid': 'A pairing code has 6 letters and digits, like ABC-DEF.',
        'pairing.result.paused': 'Pairing is paused. Resume it first.',
        'pairing.result.busy': 'Another code is being checked. Try again in a moment.',
        'pairing.result.failed': 'The code could not be checked. Try again.',
        'pairing.paused.user': 'Pairing is paused: no browser can ask to connect.',
        'pairing.paused.failures': 'Pairing was paused after several wrong codes. If that was not you, something on this computer is trying to pair. Resume when you want to pair a browser.',
        'pairing.pause': 'Pause pairing',
        'pairing.resume': 'Resume pairing',
        'pairing.paired': 'Paired extensions',
        'pairing.unpair': 'Unpair',
        'pairing.unpairNote': 'Unpairing disconnects that extension and refuses it from now on. It still holds the bridge token: if the browser is no longer yours, also reset the token.',
        'pairing.reset': 'Reset bridge token',
        'pairing.resetConfirm': 'Reset now',
        'pairing.resetCancel': 'Cancel',
        'pairing.resetWarning': 'This replaces the bridge token and disconnects every browser. The installed developer extension picks the new token up by itself; paired browsers pair again.',
        'pairing.resetDone': 'The bridge token was replaced. Every browser was disconnected.',
        'pairing.resetPinned': 'The bridge token is pinned in the plugin config; change it there to revoke it.',
      },
      zh: {
        'bridgeAddress.title': '浏览器桥地址',
        'bridgeAddress.help': '粘贴到 Chrome 扩展「桥地址」设置；本机一般无需 Token。',
        'bridgeAddress.copy': '复制',
        'bridgeAddress.copied': '已复制',
        'bridgeAddress.loading': '正在读取…',
        'bridgeAddress.unavailable': '暂时无法读取桥地址',
        'pairing.title': '配对浏览器',
        'pairing.wants': '有浏览器请求连接',
        'pairing.prompt': '请输入它显示的配对码',
        'pairing.official': 'dsh Browser Agent（官方）',
        'pairing.unknown': '未知扩展 {0} — 不是已发布的 DSH 扩展',
        'pairing.unknownWarning': '仅当该扩展是你自己安装并且信任的，才为未知扩展输入配对码：它将能够操作 DSH。',
        'pairing.says': '自称是 {0}',
        'pairing.only': '仅当你自己打开了 DSH 浏览器扩展并且它显示了配对码时，才在这里输入。',
        'pairing.placeholder': 'ABC-DEF',
        'pairing.connect': '连接',
        'pairing.checking': '正在检查…',
        'pairing.waiting': '正在等待配对码的浏览器：{0} 个。请输入你的浏览器显示的配对码。',
        'pairing.idle': '打开 DSH 浏览器扩展：它的侧边栏会显示一个 6 位配对码。在这里输入该配对码。',
        'pairing.result.paired': '已与 {0} 配对，浏览器会自动连接。',
        'pairing.result.unconfirmed': '配对码正确，但浏览器没有确认。如果它的侧边栏没有连接，请在浏览器中重新请求。',
        'pairing.result.no-match': '没有等待中的浏览器显示这个配对码。一个配对码只能尝试一次：请在浏览器中选择「重新请求」，然后输入新的配对码。',
        'pairing.result.none-waiting': '没有浏览器在等待。请先打开 DSH 浏览器扩展。',
        'pairing.result.invalid': '配对码由 6 位字母和数字组成，例如 ABC-DEF。',
        'pairing.result.paused': '配对已暂停，请先恢复。',
        'pairing.result.busy': '正在检查另一个配对码，请稍后再试。',
        'pairing.result.failed': '无法检查配对码，请重试。',
        'pairing.paused.user': '配对已暂停：浏览器无法请求连接。',
        'pairing.paused.failures': '多次输入错误的配对码后，配对已暂停。如果不是你操作的，说明本机上有程序在尝试配对。需要配对浏览器时再恢复。',
        'pairing.pause': '暂停配对',
        'pairing.resume': '恢复配对',
        'pairing.paired': '已配对的扩展',
        'pairing.unpair': '取消配对',
        'pairing.unpairNote': '取消配对会断开该扩展并从此拒绝它。但它仍持有桥接令牌：如果该浏览器已不属于你，还需重置令牌。',
        'pairing.reset': '重置桥接令牌',
        'pairing.resetConfirm': '立即重置',
        'pairing.resetCancel': '取消',
        'pairing.resetWarning': '这会更换桥接令牌并断开所有浏览器。已安装的开发者扩展会自动使用新令牌；已配对的浏览器需重新配对。',
        'pairing.resetDone': '桥接令牌已更换，所有浏览器已断开。',
        'pairing.resetPinned': '桥接令牌固定在插件配置中；如需吊销，请在配置中修改。',
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
        '.dshBridgePairForm{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dshBridgePairInput{flex:none;width:9.5em;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:600 16px/22px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:0.12em;text-transform:uppercase}',
        // A fixed-height line: messages come and go without moving the input or the buttons.
        '.dshBridgePairStatus{min-height:36px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
        '.dshBridgePairPaired{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dshBridgePairWho{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
        '.dshBridgePairWarn{margin:0;color:var(--dsw-alias-label-danger,var(--dsw-alias-label-primary));font-size:12px;font-weight:600;line-height:18px;overflow-wrap:anywhere}',
        '.dshBridgePairId{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font:400 12px/18px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshBridgePairPrompt{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;width:min(360px,calc(100vw - 32px));padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-base,Canvas);box-shadow:0 8px 28px rgba(0,0,0,.18)}',
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
        signal: AbortSignal.timeout(15_000),
      })
      let body = null
      try { body = await response.json() } catch { /* not JSON: an auth or routing error page */ }
      return { status: response.status, body }
    }

    function fill(template, value) {
      return template.replace('{0}', value)
    }

    /** A slot may render without a translator (no locale service): fall back to English. */
    function translator(t) {
      return typeof t === 'function' ? t : key => dictionaries.en[key] ?? key
    }

    const EXTENSION_ORIGIN = /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f-]{36})$/

    /** The part of an extension origin a person can compare: the ID or the UUID. */
    function extensionId(origin) {
      return origin.replace(/^(?:chrome|moz)-extension:\/\//, '')
    }

    /** Only what this page expects of a status answer; anything else reads as "nothing known". */
    function readStatus(body) {
      if (body === null || typeof body !== 'object' || body.ok !== true) return null
      const requests = Array.isArray(body.requests)
        ? body.requests.filter(request => request !== null && typeof request === 'object' && EXTENSION_ORIGIN.test(request.origin))
          .map(request => ({
            origin: request.origin,
            name: typeof request.name === 'string' && /^[A-Za-z]{1,16}$/.test(request.name) ? request.name : '',
            official: request.official === true,
          }))
        : []
      return {
        paused: body.paused === true,
        pauseReason: body.pauseReason === 'failures' ? 'failures' : 'user',
        waiting: requests.length,
        requests,
        pairedOrigins: Array.isArray(body.pairedOrigins) ? body.pairedOrigins.filter(origin => EXTENSION_ORIGIN.test(origin)) : [],
        canResetToken: body.canResetToken === true,
        lastPaired: EXTENSION_ORIGIN.test(body.paired?.origin) ? body.paired.origin : null,
      }
    }

    /**
     * The pairing desk on the host, kept current by polling, and the actions
     * on it. Every mounted view runs its own copy; the host is the single
     * source of truth. Polling stops for good when the host has no pairing
     * route (`pairing: false`, or an older plugin).
     */
    function usePairingDesk() {
      const [desk, setDesk] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let stopped = false
        let timer
        const poll = async () => {
          let delay = PAIRING_POLL_MS
          try {
            const { status, body } = await pairingRequest({ action: 'status' })
            if (stopped) return
            if (status === 404) {
              setDesk(null)
              return
            }
            if (status === 200) setDesk(readStatus(body))
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
      }, [])

      React.useEffect(() => {
        if (notice === null) return undefined
        const timer = window.setTimeout(() => setNotice(null), PAIRING_NOTICE_MS)
        return () => window.clearTimeout(timer)
      }, [notice])

      const act = React.useCallback(async (payload) => {
        setBusy(true)
        try {
          const { status, body } = await pairingRequest(payload)
          const next = status === 200 ? readStatus(body) : null
          if (next !== null) setDesk(next)
          if (payload.action === 'enter') {
            const result = next !== null && typeof body.result === 'string' ? body.result : 'failed'
            // A success names who was paired, so a wrong one can be unpaired on the spot.
            setNotice({ key: `pairing.result.${result}`, origin: result === 'paired' || result === 'unconfirmed' ? next.lastPaired : null })
            return result
          }
          if (payload.action === 'unpair') setNotice(null)
          if (payload.action === 'reset-token') setNotice(next !== null ? { key: 'pairing.resetDone', origin: null } : null)
        } catch {
          if (payload.action === 'enter') setNotice({ key: 'pairing.result.failed', good: false })
        } finally {
          setBusy(false)
        }
        return undefined
      }, [])

      return { desk, notice, busy, act }
    }

    /** The one input: the code the browser shows, submitted with Enter. Its layout does not change with the messages. */
    function PairingEntry({ t, state, autoFocus }) {
      const [code, setCode] = React.useState('')
      const submit = async (event) => {
        event.preventDefault()
        if (state.busy || code.trim() === '') return
        const result = await state.act({ action: 'enter', code })
        // A code is good for one try: never leave it in the field.
        if (result !== 'invalid') setCode('')
      }
      const known = state.notice !== null && Object.hasOwn(dictionaries.en, state.notice.key)
      const pairedOrigin = known && typeof state.notice.origin === 'string' ? state.notice.origin : null
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'form',
          { className: 'dshBridgePairForm', onSubmit: (event) => { void submit(event) } },
          React.createElement('input', {
            className: 'dshBridgePairInput',
            'data-testid': 'dsh-pairing-input',
            'aria-label': t('pairing.prompt'),
            placeholder: t('pairing.placeholder'),
            value: code,
            maxLength: 9,
            autoComplete: 'off',
            autoCapitalize: 'characters',
            spellCheck: false,
            autoFocus: autoFocus === true,
            disabled: state.busy,
            onChange: (event) => { setCode(event.target.value) },
          }),
          React.createElement(
            'button',
            { type: 'submit', className: 'dshBridgeAddressCopy', disabled: state.busy || code.trim() === '' },
            state.busy ? t('pairing.checking') : t('pairing.connect'),
          ),
        ),
        React.createElement('p', { className: 'dshBridgePairStatus', role: 'status', 'data-testid': 'dsh-pairing-status' },
          known ? fill(t(state.notice.key), pairedOrigin === null ? '' : extensionId(pairedOrigin)) : '',
          pairedOrigin === null ? null : ' ',
          pairedOrigin === null ? null : React.createElement(
            'button',
            { type: 'button', className: 'dshBridgeAddressCopy', 'data-testid': 'dsh-pairing-undo', disabled: state.busy, onClick: () => { void state.act({ action: 'unpair', origin: pairedOrigin }) } },
            t('pairing.unpair'),
          )),
      )
    }

    /** Who is asking, per waiting request: the published extension, or an unknown one (in warning style). */
    function PairingRequesters({ t, requests }) {
      return React.createElement(
        React.Fragment,
        null,
        requests.map((request, index) => React.createElement(
          'p',
          { key: `${request.origin}#${String(index)}`, className: request.official ? 'dshBridgePairWho' : 'dshBridgePairWarn', 'data-testid': 'dsh-pairing-requester' },
          request.official ? t('pairing.official') : fill(t('pairing.unknown'), extensionId(request.origin)),
          request.name === '' ? '' : ` (${fill(t('pairing.says'), request.name)})`,
        )),
        requests.some(request => !request.official)
          ? React.createElement('p', { className: 'dshBridgeAddressHelp' }, t('pairing.unknownWarning'))
          : null,
      )
    }

    /** The card over the app: nothing until a browser waits, then the prompt and the input. */
    function PairingPrompt({ t }) {
      const tr = translator(t)
      const state = usePairingDesk()
      const waiting = state.desk !== null && !state.desk.paused && state.desk.waiting > 0
      // While the answer to a code is on screen the card keeps the lines it had, so nothing moves under the pointer.
      const lastRequests = React.useRef([])
      if (waiting) lastRequests.current = state.desk.requests
      if (!waiting && state.notice === null) return null
      return React.createElement(
        'div',
        { className: 'dshBridgePairPrompt', role: 'dialog', 'aria-label': tr('pairing.wants'), 'data-testid': 'dsh-pairing-prompt' },
        React.createElement('div', { className: 'dshBridgeAddressTitle' }, tr('pairing.wants')),
        React.createElement(PairingRequesters, { t: tr, requests: lastRequests.current }),
        React.createElement('p', { className: 'dshBridgeAddressHelp' }, `${tr('pairing.prompt')}.`),
        React.createElement(PairingEntry, { t: tr, state }),
        React.createElement('p', { className: 'dshBridgeAddressHelp' }, tr('pairing.only')),
      )
    }

    /** The General-settings row: the same input, plus Pause/Resume and the paired extensions. */
    function PairBrowserRow({ t }) {
      const tr = translator(t)
      const state = usePairingDesk()
      const [confirmReset, setConfirmReset] = React.useState(false)
      const desk = state.desk
      if (desk === null) return null
      return React.createElement(
        'div',
        { className: 'dshBridgeAddressRow dshBridgePairRow' },
        React.createElement('div', { className: 'dshBridgeAddressTitle' }, tr('pairing.title')),
        React.createElement('p', { className: 'dshBridgeAddressHelp', 'data-testid': 'dsh-pairing-summary' },
          desk.paused
            ? tr(desk.pauseReason === 'failures' ? 'pairing.paused.failures' : 'pairing.paused.user')
            : desk.waiting > 0 ? fill(tr('pairing.waiting'), String(desk.waiting)) : tr('pairing.idle')),
        desk.paused ? null : React.createElement(PairingRequesters, { t: tr, requests: desk.requests }),
        desk.paused ? null : React.createElement(PairingEntry, { t: tr, state }),
        React.createElement(
          'div',
          { className: 'dshBridgeAddressBody' },
          React.createElement(
            'button',
            { type: 'button', className: 'dshBridgeAddressCopy', disabled: state.busy, onClick: () => { void state.act({ action: desk.paused ? 'resume' : 'pause' }) } },
            desk.paused ? tr('pairing.resume') : tr('pairing.pause'),
          ),
        ),
        desk.pairedOrigins.length === 0 ? null : React.createElement(
          React.Fragment,
          null,
          React.createElement('div', { className: 'dshBridgeAddressTitle' }, tr('pairing.paired')),
          desk.pairedOrigins.map(origin => React.createElement(
            'div',
            { key: origin, className: 'dshBridgePairPaired' },
            React.createElement('code', { className: 'dshBridgePairId', title: origin }, origin),
            React.createElement('button', { type: 'button', className: 'dshBridgeAddressCopy', disabled: state.busy, onClick: () => { void state.act({ action: 'unpair', origin }) } }, tr('pairing.unpair')),
          )),
          React.createElement('p', { className: 'dshBridgeAddressHelp' }, tr('pairing.unpairNote')),
        ),
        // Revoking the token itself: two clicks, because it disconnects every browser.
        !desk.canResetToken
          ? React.createElement('p', { className: 'dshBridgeAddressHelp' }, tr('pairing.resetPinned'))
          : confirmReset
            ? React.createElement(
              React.Fragment,
              null,
              React.createElement('p', { className: 'dshBridgePairWarn', role: 'alert' }, tr('pairing.resetWarning')),
              React.createElement(
                'div',
                { className: 'dshBridgeAddressBody' },
                React.createElement('button', { type: 'button', className: 'dshBridgeAddressCopy', onClick: () => { setConfirmReset(false) } }, tr('pairing.resetCancel')),
                React.createElement('button', { type: 'button', className: 'dshBridgeAddressCopy', disabled: state.busy, onClick: () => { setConfirmReset(false); void state.act({ action: 'reset-token' }) } }, tr('pairing.resetConfirm')),
              ),
            )
            : React.createElement(
              'div',
              { className: 'dshBridgeAddressBody' },
              React.createElement('button', { type: 'button', className: 'dshBridgeAddressCopy', disabled: state.busy, onClick: () => { setConfirmReset(true) } }, tr('pairing.reset')),
            ),
        desk.paused && state.notice !== null && Object.hasOwn(dictionaries.en, state.notice.key)
          ? React.createElement('p', { className: 'dshBridgePairStatus', role: 'status' }, tr(state.notice.key))
          : null,
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
