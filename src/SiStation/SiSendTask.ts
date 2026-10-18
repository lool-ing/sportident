// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiStation/SiSendTask.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Stripped lodash; no enums.
//   - DeviceClosedError + SendTimeoutError imported from ../transport/errors.ts,
//     with no inline class definitions in this file.
//   - Trimmed upstream's RFC-style state-machine to the Phase 0 surface: pending
//     -> resolved-or-rejected. No "retry" / "back-off" — Phase 1 owns retry policy.
//   - typescript-eslint-friendly: explicit resolve/reject capture (no `as` casts on
//     the deferred-promise pattern).
// See NOTICE.md for cumulative attribution.

import type { SiMessage } from '../siProtocol.ts';
import { DeviceClosedError, SendTimeoutError } from '../transport/errors.ts';

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * State machine for a single command-response pair. The multiplexer creates one
 * per `sendMessage()` call, enqueues it, then resolves it when a matching
 * response frame arrives. Timeout fires `SendTimeoutError`; transport close
 * fires `DeviceClosedError` via `abort()`.
 */
export class SiSendTask {
  public readonly message: SiMessage;
  /** Expected number of response frames before resolving. Defaults to 1. */
  public readonly expectedResponses: number;
  public readonly timeoutMs: number;
  public readonly promise: Promise<number[][]>;

  private resolve!: (responses: number[][]) => void;
  private reject!: (err: Error) => void;
  private timeoutHandle: NodeJS.Timeout | undefined;
  private settled = false;
  private collectedResponses: number[][] = [];

  constructor(message: SiMessage, expectedResponses = 1, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.message = message;
    this.expectedResponses = expectedResponses;
    this.timeoutMs = timeoutMs;
    this.promise = new Promise<number[][]>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Command-bearing messages get a timeout; bare-mode messages (ACK/WAKEUP)
    // don't need a response and skip the timer. The timer KEEPS the event loop
    // alive (no unref) — bin/lool-readout is otherwise idle while waiting for
    // station replies, and `await task.promise` must reliably reject.
    if (message.mode === undefined) {
      this.timeoutHandle = setTimeout(() => {
        if (this.settled) return;
        this.settled = true;
        const cmd = message.command;
        this.reject(new SendTimeoutError(cmd, this.timeoutMs));
      }, this.timeoutMs);
    }
  }

  /** Feed a response frame's payload (`number[]`). Resolves when we've
   * collected `expectedResponses` frames; returns whether the task is done. */
  receive(frame: number[]): boolean {
    if (this.settled) return true;
    this.collectedResponses.push(frame);
    if (this.collectedResponses.length >= this.expectedResponses) {
      this.settled = true;
      if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
      this.resolve(this.collectedResponses);
    }
    return this.settled;
  }

  /** Externally-triggered abort — used by SiTargetMultiplexer on transport close. */
  abort(reason?: string): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.reject(new DeviceClosedError(reason ?? 'send aborted by transport close'));
  }

  /** Mark this task settled without resolving — for write-side errors (eg
   * transport.send() rejected). The caller is responsible for forwarding the
   * underlying error to the consumer. */
  failWithError(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.reject(err);
  }
}
