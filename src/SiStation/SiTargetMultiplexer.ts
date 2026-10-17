// Ported (heavily simplified) from allestuetsmerweh/sportident.js — SiStation/SiTargetMultiplexer.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications (the simplification is the point):
//   - DIRECT-ONLY: dropped the SET_MS-on-every-call dance + the Remote / Unknown
//     target handling. Phase 0 only reads from one direct-attached station via
//     /dev/ttyUSB0. Removed
//     branches are tagged `// REMOVED (Phase 0 Direct-only)`.
//   - WAKEUP prepending: _renderForWire() prepends proto.WAKEUP
//     to EVERY rendered command, not only the initial handshake. Matches upstream's
//     SiTargetMultiplexer L237-240 behavior (research-verified).
//   - onFrameError wiring: parseAll(buf, {onFrameError}) callback
//     directly emits 'frameError'. NO stdout interception anywhere — the typed
//     FrameError payload from siProtocol flows through unchanged.
//   - 64KB receive-buffer cap: if the buffer
//     exceeds 64KB without yielding a complete frame, drop it and emit a typed
//     buffer_overflow frameError. Protects against adversarial / noisy byte streams.
//   - Send-queue: serializes sendMessage() so back-to-back commands resolve in
//     order. The transport's own send-queue already serializes writes; this
//     layer's queue serializes response-pairing so we never have two pending
//     SiSendTasks racing for the same response.
//   - Transport 'close' rejects every pending SiSendTask with DeviceClosedError
// // See NOTICE.md for cumulative attribution.

import { proto } from '../constants.ts';
import { parseAll, render, type FrameError, type SiMessage } from '../siProtocol.ts';
import { EventEmitter } from '../utils/events.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { DeviceClosedError } from '../transport/errors.ts';
import { SiSendTask } from './SiSendTask.ts';

const RECEIVE_BUFFER_CAP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Public events:
 *  - 'message': forwards every parsed SiMessage that isn't claimed by a pending
 *    SiSendTask (card-insertion frames, autosend, etc.). REMOVED (Phase 0
 *    Direct-only) for the upstream pattern — we
 *    keep this hook so SiMainStation can dispatch SI5_DET/SI8_DET/SI_REM.
 *  - 'frameError': typed FrameError from siProtocol.parseAll (CRC mismatch,
 *    bad ETX, buffer overflow).
 *  - 'close': underlying transport closed.
 */
export class SiTargetMultiplexer extends EventEmitter {
  private transport: ISerialTransport;
  private receiveBuffer: number[] = [];
  /** Send queue: only one SiSendTask in-flight at a time. */
  private pendingSendTasks: SiSendTask[] = [];
  private sendChain: Promise<unknown> = Promise.resolve();
  private isClosed = false;

  constructor(transport: ISerialTransport) {
    super();
    this.transport = transport;
    this.transport.on('data', (bytes: number[]) => this._onData(bytes));
    this.transport.on('close', () => this._handleTransportClose());
  }

  /** Render `message` for wire transmission. WAKEUP byte is
   * prepended to EVERY command, not just the handshake. Matches upstream's
   * `[proto.WAKEUP, ...siProtocol.render(message)]` pattern. */
  private _renderForWire(message: SiMessage): number[] {
    return [proto.WAKEUP, ...render(message)];
  }

  /**
   * Send `message` and resolve with up to `expectedResponses` matching response
   * frames. Times out per `timeoutMs` (default 10s; tests override to 100ms).
   * Reject types:
   *   - SendTimeoutError if the station never replies in time.
   *   - DeviceClosedError if the transport closes mid-flight.
   *   - Underlying transport.send() rejections propagate as-is.
   */
  sendMessage(
    message: SiMessage,
    expectedResponses = 1,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<number[][]> {
    if (this.isClosed) {
      return Promise.reject(new DeviceClosedError('multiplexer closed'));
    }
    const task = new SiSendTask(message, expectedResponses, timeoutMs);
    this.pendingSendTasks.push(task);
    // unconditional cleanup hook so a timeout, abort,
    // or any other settle path (not just successful completion via _dispatch)
    // removes the task from pendingSendTasks. Without this, a timed-out head
    // task stays in the queue forever and any subsequent response is routed
    // against the dead task — making the next sendMessage time out too.
    //
    // The trailing `.catch(() => undefined)` is mandatory: `.finally()`
    // returns a NEW promise that adopts the rejection of `task.promise`. If
    // the caller's original rejection is the only handler (the typical case
    // for `await sendMessage(...)` rejecting on timeout), this chained
    // promise has no handler and triggers an unhandledRejection. The catch
    // is a no-op — the caller already saw the rejection on `task.promise`.
    task.promise.finally(() => this._removeTask(task)).catch(() => undefined);

    // Chain transport.send onto sendChain so consecutive sendMessage calls
    // serialize their wire transmissions. Errors do NOT poison the queue —
    // each send catches its own error and fails its own task.
    this.sendChain = this.sendChain
      .catch(() => undefined)
      .then(() => {
        if (this.isClosed) {
          task.failWithError(new DeviceClosedError('transport closed before send'));
          // No explicit _removeTask here — the failWithError above causes
          // task.promise to reject which triggers the finally() cleanup.
          return undefined;
        }
        return this.transport.send(this._renderForWire(message)).catch((err: Error) => {
          task.failWithError(err);
          // Same: finally() cleanup handles removal.
        });
      });

    return task.promise;
  }

  /**
   * Fire-and-forget: send a single bare ACK byte (0x06). Used after a
   * successful card read to signal "release the card" — on BSx readers this
   * triggers the post-read beep and stops the station from continuing to
   * report the same card. NOT a command-response cycle: no SiSendTask, no
   * timeout, no WAKEUP prefix (single-byte mode messages are bare per the
   * SI protocol — see constants.ts and format).
   *
   * Chained onto the same sendChain as full commands so it serialises after
   * the preceding GET_SI5/GET_SI8 read and before any subsequent command.
   *    */
  sendBareAck(): Promise<void> {
    if (this.isClosed) {
      return Promise.reject(new DeviceClosedError('multiplexer closed'));
    }
    // Return a promise that resolves after the send completes. The send is
    // appended to sendChain so it serialises after any in-flight commands.
    return new Promise<void>((resolve, reject) => {
      this.sendChain = this.sendChain
        .catch(() => undefined)
        .then(() => {
          if (this.isClosed) {
            reject(new DeviceClosedError('transport closed before bare ACK'));
            return undefined;
          }
          return this.transport.send([proto.ACK]).then(resolve, reject);
        });
    });
  }

  /** Close the multiplexer. Idempotent. Aborts any in-flight tasks first
   * (so callers awaiting sendMessage promises observe the rejection). */
  close(): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    this.isClosed = true;
    this._abortAllPendingSends('multiplexer.close() invoked');
    return this.transport.close();
  }

  // --- Receive path --------------------------------------------------------

  private _onData(bytes: number[]): void {
    // Concatenate; siProtocol.parseAll consumes prefix bytes and returns the
    // remainder. This buffer therefore shrinks deterministically ('s
    // bounded-shrinkage guarantee).
    for (const b of bytes) this.receiveBuffer.push(b);

    const { messages, remainder } = parseAll(this.receiveBuffer, {
      // Direct callback wiring, no stdout interception.
      onFrameError: (err) => this.emit('frameError', err),
    });
    this.receiveBuffer = remainder;

    for (const m of messages) this._dispatch(m);

    // cap the receive buffer so an adversarial
    // / noisy byte stream can't pin unbounded memory.
    if (this.receiveBuffer.length > RECEIVE_BUFFER_CAP_BYTES) {
      const overflowErr: FrameError = {
        error_code: 'buffer_overflow',
        raw_bytes: [],
        bytes_consumed: this.receiveBuffer.length,
      };
      this.receiveBuffer = [];
      this.emit('frameError', overflowErr);
    }
  }

  /** Route a parsed message: either to the head pending task (if it matches
   * the expected response command) or as a free-floating 'message' event. */
  private _dispatch(message: SiMessage): void {
    const head = this.pendingSendTasks[0];
    // A bare NAK refuses the command in flight (eg the card was pulled mid-read):
    // fail it now instead of waiting for the timeout. Other bare modes
    // (ACK/WAKEUP) are dropped.
    if (message.mode !== undefined) {
      if (message.mode === proto.NAK && head) {
        head.failWithError(new Error('NAK'));
        this._removeTask(head);
      }
      return;
    }

    if (head && head.message.mode === undefined) {
      const sentCommand = head.message.command;
      // Modern SI cards: GET_SI5 / GET_SI8 responses echo their request command.
      // SI5_DET / SI8_DET / SI_REM are async station-initiated; route to 'message'.
      if (message.command === sentCommand) {
        const frame = [message.command, message.parameters.length, ...message.parameters];
        head.receive(frame);
        // Re-check settled state via the public promise; remove if done.
        // (SiSendTask.receive resolves when expectedResponses is hit; we know
        // synchronously that the task is settled if we received the final frame.)
        // We can detect this by attempting to peek at collectedResponses, but
        // SiSendTask doesn't expose that — instead, we always remove after one
        // matching frame for Phase 0's expectedResponses=1 default. If we ever
        // need multi-frame, this dispatch will need state.
        this._removeTask(head);
        return;
      }
    }
    // Free-floating: let SiMainStation handle SI5_DET / SI8_DET / SI_REM.
    this.emit('message', message);
  }

  private _removeTask(task: SiSendTask): void {
    const idx = this.pendingSendTasks.indexOf(task);
    if (idx >= 0) this.pendingSendTasks.splice(idx, 1);
  }

  private _handleTransportClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this._abortAllPendingSends('transport closed');
    this.emit('close');
  }

  /** Fail every in-flight task: with DeviceClosedError on disconnect (#9, so
   * bin/lool-readout doesn't hang in zombie state), or with `error` when the
   * card being read leaves the station. */
  _abortAllPendingSends(reason: string, error?: Error): void {
    const tasks = this.pendingSendTasks;
    this.pendingSendTasks = [];
    for (const t of tasks) {
      if (error) t.failWithError(error);
      else t.abort(reason);
    }
  }
}
