/**
 * In-memory stand-in for the browser WebSocket, for suites that stub the
 * global (`vi.stubGlobal('WebSocket', FakeWebSocket)`). Every constructed
 * socket is kept in `FakeWebSocket.instances`; reset it in `afterEach`.
 */
export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  /** Frames the client sent, parsed. */
  readonly sent: unknown[] = []
  /** Close code and reason of the first close. */
  closedWith: { code: number; reason: string } | undefined

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  /** Deliver one server frame (JSON-encoded). */
  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  /** Deliver raw message data as-is. */
  receiveRaw(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.closedWith = { code, reason }
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new CloseEvent('close', { code, reason }))
  }
}
