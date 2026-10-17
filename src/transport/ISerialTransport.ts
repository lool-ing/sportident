// Authored for lool. Not ported from upstream.
// Transport interface — DI seam for SiTargetMultiplexer + SiMainStation.
//
/**
 * Byte-stream serial transport.
 *
 * Emits `'data'` events with **`number[]`** (not Buffer) so consumers can feed
 * the array straight into `siProtocol.parseAll` without an extra `Array.from`
 * call. `'close'` is emitted once when the underlying port closes; any pending
 * `send()` after that rejects synchronously with `DeviceClosedError`.
 */
export interface ISerialTransport {
  /** Open the underlying port. Rejects if the OS-level open call errors. */
  open(): Promise<void>;
  /**
   * Write `bytes` to the port. Resolves only after the OS-level drain confirms
   * the buffer has been flushed. Sequential `send()` calls preserve order
   * (back-pressure: the second resolves AFTER the first).
   *
   * Rejects with `DeviceClosedError` if invoked after the transport has been
   * closed (either via `close()` or an underlying-port `'close'` event).
   */
  send(bytes: number[]): Promise<void>;
  /** Close the underlying port. Idempotent — a second call is a no-op. */
  close(): Promise<void>;
  on(event: 'data', listener: (bytes: number[]) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
}
