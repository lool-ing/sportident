// Authored for lool. Not ported from upstream.
// // node serialport@13 wrapper that conforms to ISerialTransport. Replaces upstream's
// sportident-{webusb,node-usb} packages — Phase 0 uses the kernel-managed
// /dev/ttyUSB0 cp210x device, not raw USB control transfers.
//
// Local features beyond the upstream WebUSB transport:
//   - Send-queue serialisation (back-pressure across concurrent send() calls).
//   - 64KB recv-buffer cap → frameError 'buffer_overflow' (this lives in
//     SiTargetMultiplexer's _onData path, NOT here; the transport is
//     unfortifiable about message boundaries, it only forwards bytes).
//   - DeviceClosedError on send() after close (close() must
//     reject any pending send() promise to avoid zombie processes hanging on drains).
// See NOTICE.md for cumulative attribution.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { DeviceClosedError } from './errors.ts';
import type { ISerialTransport } from './ISerialTransport.ts';

/**
 * Minimal subset of the `serialport@13` SerialPort API surface this wrapper
 * relies on. Kept here (instead of importing the real types) so tests can
 * inject a FakeSerialPort and the runtime import of `'serialport'` is lazy
 * (only when the default constructor is used).
 */
interface NodeSerialPortLike extends EventEmitter {
  open(cb: (err: Error | null) => void): void;
  write(buf: Buffer, cb: (err: Error | null) => void): boolean;
  drain(cb: (err: Error | null) => void): void;
  close(cb: (err: Error | null) => void): void;
  update(opts: { baudRate: number }, cb: (err: Error | null) => void): void;
}

interface NodeSerialPortCtor {
  new (opts: {
    path: string;
    baudRate?: number;
    dataBits?: number;
    stopBits?: number;
    parity?: string;
    autoOpen?: boolean;
  }): NodeSerialPortLike;
}

export interface SerialTransportOpts {
  path: string;
  baudRate?: number;
}

/**
 * Lazy default — only require `serialport` when no Ctor is injected. Tests
 * always inject a FakeSerialPort, so `serialport` (a native dependency) never
 * loads in CI.
 *
 * ESM-safe: this package is `type: "module"` and `exports.import` points at
 * `dist/index.mjs`. A bare `require('serialport')` throws "Dynamic require of
 * 'serialport' is not supported" in ESM bundles and "require is not defined"
 * at source level. `createRequire(import.meta.url)` gives us a CJS require
 * resolved against this module's URL so the cjs-only `serialport` package
 * loads without a top-level await (which would force the constructor to be
 * async).
 *
 * tsup dual-bundle: the source uses `import.meta.url` (ESM-only). esbuild
 * rewrites `import.meta` to `{}` for the CJS output, so the CJS path would
 * crash if it reached `createRequire(undefined)`. Guarded by a runtime check —
 * the CJS bundle takes the `typeof __filename` branch and uses native require;
 * the ESM bundle takes the `createRequire(import.meta.url)` branch.
 */
const requireFromHere: NodeRequire = (() => {
  // CJS bundle: native `require` is in scope (tsup's CJS output already has
  // it). `typeof __filename` is a cheap way to detect CJS without referencing
  // `require` at module top-level (which esbuild's lint would warn about).
  if (typeof __filename !== 'undefined') {
    return createRequire(__filename);
  }
  // ESM bundle: `import.meta.url` is the canonical anchor for createRequire.
  return createRequire(import.meta.url);
})();
const defaultSerialPortCtor = (): NodeSerialPortCtor => {
  const mod = requireFromHere('serialport') as { SerialPort: NodeSerialPortCtor };
  return mod.SerialPort;
};

export class SerialTransport extends EventEmitter implements ISerialTransport {
  private port: NodeSerialPortLike;
  private isClosed = false;
  /** Serializes concurrent send() calls so back-to-back writes preserve order. */
  private sendQueue: Promise<void> = Promise.resolve();
  /** Pending in-flight send rejecters: invoked en masse on 'close'. */
  private pendingRejecters: Array<(err: Error) => void> = [];

  constructor(opts: SerialTransportOpts, SerialPortCtor?: NodeSerialPortCtor) {
    super();
    const Ctor = SerialPortCtor ?? defaultSerialPortCtor();
    this.port = new Ctor({
      path: opts.path,
      baudRate: opts.baudRate ?? 38400,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
    });
    this.port.on('data', (chunk: Buffer) => {
      // Emit as number[] (not Buffer) so siProtocol.parseAll consumes it directly.
      this.emit('data', Array.from(chunk));
    });
    this.port.on('error', (err: Error) => this.emit('error', err));
    this.port.on('close', () => this.handlePortClose());
  }

  open(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.port.open((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Changes the rate of the open port (`--baud auto` retries at 4800). */
  setBaudRate(baudRate: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.port.update({ baudRate }, (err) => (err ? reject(err) : resolve()));
    });
  }

  send(bytes: number[]): Promise<void> {
    if (this.isClosed) {
      return Promise.reject(new DeviceClosedError('transport closed'));
    }
    // Chain onto sendQueue: only one in-flight write at a time. Errors are
    // surfaced to the caller but do NOT poison the queue for subsequent sends.
    let rejecter: (err: Error) => void = () => {};
    const writePromise = new Promise<void>((resolve, reject) => {
      rejecter = reject;
      this.pendingRejecters.push(reject);
      // Defer the actual write until the queue's tail resolves.
      this.sendQueue = this.sendQueue.then(() =>
        this.performWrite(bytes).then(
          () => {
            this.pendingRejecters = this.pendingRejecters.filter((r) => r !== reject);
            resolve();
          },
          (err: Error) => {
            this.pendingRejecters = this.pendingRejecters.filter((r) => r !== reject);
            reject(err);
          }
        )
      );
    });
    // Re-attach to keep the queue alive even if writePromise rejects (so the
    // next send can still proceed). The rejecter reference is consumed by the
    // close path; nothing else needs it.
    void rejecter;
    return writePromise;
  }

  private performWrite(bytes: number[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.isClosed) {
        reject(new DeviceClosedError('transport closed'));
        return;
      }
      let writeErrored = false;
      const ok = this.port.write(Buffer.from(bytes), (err) => {
        if (err) {
          writeErrored = true;
          reject(err);
        }
      });
      if (writeErrored) return;
      if (!ok) {
        this.port.once('drain', () => resolve());
      } else {
        this.port.drain((err) => {
          if (err) reject(err);
          else resolve();
        });
      }
    });
  }

  close(): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.port.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handlePortClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    // reject any in-flight send promises so zombie processes
    // don't hang on a drain that will never resolve.
    const closedErr = new DeviceClosedError('transport closed mid-flight');
    const rejecters = this.pendingRejecters;
    this.pendingRejecters = [];
    for (const reject of rejecters) {
      try {
        reject(closedErr);
      } catch {
        // ignore — already-resolved rejecters throw; not our problem
      }
    }
    this.emit('close');
  }
}
