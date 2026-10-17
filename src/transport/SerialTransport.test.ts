// Authored for lool. Not ported from upstream.
// SerialTransport unit tests against a FakeSerialPort.
// Zero real-hardware dependency: the SerialTransport constructor accepts an
// injection-point so tests substitute a FakeSerialPort that mimics the
// serialport@13 API surface (open/write/drain/close + on('data'|'error'|'close')).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { SerialTransport } from './SerialTransport.ts';
import { DeviceClosedError } from './errors.ts';

// --- FakeSerialPort ---------------------------------------------------------
// Mimics the subset of `serialport@13`'s API that SerialTransport touches.
// Behavior:
//   - constructor stashes the opts, does NOT auto-open (matches autoOpen: false).
//   - open(cb): synchronous success unless `failOpen` is set; calls cb(null) on success.
//   - write(buf, cb): records the chunk in `writes`, calls cb(null) on next tick,
//     returns true (no back-pressure simulated by default).
//   - drain(cb): calls cb(null) on next tick.
//   - close(cb): emits 'close', calls cb(null) on next tick.
//   - on(...) inherits from EventEmitter.
// Tests drive synthetic 'data' / 'error' / 'close' events via the EventEmitter.

interface FakeOpts {
  path: string;
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  autoOpen?: boolean;
}

class FakeSerialPort extends EventEmitter {
  public opts: FakeOpts;
  public writes: Buffer[] = [];
  public isOpen = false;
  public failOpen: Error | null = null;
  public writeReturnValue = true; // default: no back-pressure
  public closed = false;

  constructor(opts: FakeOpts) {
    super();
    this.opts = opts;
  }

  open(cb: (err: Error | null) => void): void {
    if (this.failOpen) {
      setImmediate(() => cb(this.failOpen));
      return;
    }
    this.isOpen = true;
    setImmediate(() => cb(null));
  }

  write(buf: Buffer, cb: (err: Error | null) => void): boolean {
    this.writes.push(buf);
    setImmediate(() => cb(null));
    return this.writeReturnValue;
  }

  drain(cb: (err: Error | null) => void): void {
    setImmediate(() => cb(null));
  }

  close(cb: (err: Error | null) => void): void {
    this.closed = true;
    this.isOpen = false;
    setImmediate(() => {
      this.emit('close');
      cb(null);
    });
  }
}

// Helper: spin event loop one tick.
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('SerialTransport', () => {
  test('1) constructs without throwing (autoOpen: false; deps not opened)', () => {
    const t = new SerialTransport(
      { path: '/dev/ttyUSB0', baudRate: 38400 },
      FakeSerialPort as unknown as never
    );
    assert.ok(t);
  });

  test('2) open() resolves when the underlying port.open succeeds', async () => {
    let fake!: FakeSerialPort;
    const Ctor = function (opts: FakeOpts) {
      fake = new FakeSerialPort(opts);
      return fake;
    } as unknown as new (opts: FakeOpts) => FakeSerialPort;
    const t = new SerialTransport({ path: '/dev/ttyUSB0', baudRate: 38400 }, Ctor as never);
    await t.open();
    assert.strictEqual(fake.isOpen, true);
  });

  test('3) open() rejects when port.open errors', async () => {
    let fake!: FakeSerialPort;
    const Ctor = function (opts: FakeOpts) {
      fake = new FakeSerialPort(opts);
      fake.failOpen = new Error('EACCES');
      return fake;
    } as unknown as new (opts: FakeOpts) => FakeSerialPort;
    const t = new SerialTransport({ path: '/dev/ttyUSB0', baudRate: 38400 }, Ctor as never);
    await assert.rejects(() => t.open(), /EACCES/);
  });

  test('4) send() writes bytes and resolves after drain', async () => {
    let fake!: FakeSerialPort;
    const Ctor = function (opts: FakeOpts) {
      fake = new FakeSerialPort(opts);
      return fake;
    } as unknown as new (opts: FakeOpts) => FakeSerialPort;
    const t = new SerialTransport({ path: '/dev/ttyUSB0', baudRate: 38400 }, Ctor as never);
    await t.open();
    await t.send([0x02, 0xf0, 0x01, 0x4d]);
    assert.strictEqual(fake.writes.length, 1);
    assert.deepStrictEqual(Array.from(fake.writes[0] as Buffer), [0x02, 0xf0, 0x01, 0x4d]);
  });

  test('5) back-to-back send() preserves order (back-pressure)', async () => {
    let fake!: FakeSerialPort;
    const Ctor = function (opts: FakeOpts) {
      fake = new FakeSerialPort(opts);
      return fake;
    } as unknown as new (opts: FakeOpts) => FakeSerialPort;
    const t = new SerialTransport({ path: '/dev/ttyUSB0', baudRate: 38400 }, Ctor as never);
    await t.open();
    const completionOrder: number[] = [];
    const p1 = t.send([0x01]).then(() => completionOrder.push(1));
    const p2 = t.send([0x02]).then(() => completionOrder.push(2));
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(completionOrder, [1, 2]);
    // Both writes reached the port in order.
    assert.strictEqual(fake.writes.length, 2);
    assert.deepStrictEqual(Array.from(fake.writes[0] as Buffer), [0x01]);
    assert.deepStrictEqual(Array.from(fake.writes[1] as Buffer), [0x02]);
  });

  test("6) port 'data' Buffer chunk -> transport 'data' number[] (Array.isArray true)", async () => {
    let fake!: FakeSerialPort;
    const Ctor = function (opts: FakeOpts) {
      fake = new FakeSerialPort(opts);
      return fake;
    } as unknown as new (opts: FakeOpts) => FakeSerialPort;
    const t = new SerialTransport({ path: '/dev/ttyUSB0', baudRate: 38400 }, Ctor as never);
    await t.open();
    const received: unknown[] = [];
    t.on('data', (bytes) => received.push(bytes));
    fake.emit('data', Buffer.from([0x02, 0xf0, 0x01, 0x4d]));
    await tick();
    assert.strictEqual(received.length, 1);
    assert.strictEqual(Array.isArray(received[0]), true);
    assert.deepStrictEqual(received[0], [0x02, 0xf0, 0x01, 0x4d]);
  });

  test("7) port 'close' event -> transport 'close' emitted; subsequent send() rejects with DeviceClosedError", async () => {
    let fake!: FakeSerialPort;
    const Ctor = function (opts: FakeOpts) {
      fake = new FakeSerialPort(opts);
      return fake;
    } as unknown as new (opts: FakeOpts) => FakeSerialPort;
    const t = new SerialTransport({ path: '/dev/ttyUSB0', baudRate: 38400 }, Ctor as never);
    await t.open();
    let closeEmitted = 0;
    t.on('close', () => closeEmitted++);
    fake.emit('close');
    await tick();
    assert.strictEqual(closeEmitted, 1);
    await assert.rejects(() => t.send([0x01]), DeviceClosedError);
  });

  test("8) port 'error' event -> transport 'error' emitted with the same Error", async () => {
    let fake!: FakeSerialPort;
    const Ctor = function (opts: FakeOpts) {
      fake = new FakeSerialPort(opts);
      return fake;
    } as unknown as new (opts: FakeOpts) => FakeSerialPort;
    const t = new SerialTransport({ path: '/dev/ttyUSB0', baudRate: 38400 }, Ctor as never);
    await t.open();
    const received: Error[] = [];
    t.on('error', (err) => received.push(err));
    const boom = new Error('underlying USB error');
    fake.emit('error', boom);
    await tick();
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0], boom);
  });

  test('9) close() invokes port.close and resolves cleanly; idempotent', async () => {
    let fake!: FakeSerialPort;
    const Ctor = function (opts: FakeOpts) {
      fake = new FakeSerialPort(opts);
      return fake;
    } as unknown as new (opts: FakeOpts) => FakeSerialPort;
    const t = new SerialTransport({ path: '/dev/ttyUSB0', baudRate: 38400 }, Ctor as never);
    await t.open();
    await t.close();
    assert.strictEqual(fake.closed, true);
    // Second close is a no-op (does not throw).
    await t.close();
  });

  test('10) close() rejects any in-flight pending send (zombie-process prevention)', async () => {
    // Make write() pause: cb is never called. We invoke close() while a send is pending.
    let fake!: FakeSerialPort;
    const Ctor = function (opts: FakeOpts) {
      fake = new FakeSerialPort(opts);
      // Override write to NEVER fire the callback — simulates a hung serial buffer.
      fake.write = (buf: Buffer): boolean => {
        fake.writes.push(buf);
        return true; // no drain, no cb invocation
      };
      // Override drain to never fire its callback either — the test exercises the
      // path where the OS-level drain hangs and the transport close arrives mid-flight.
      fake.drain = (): void => {
        // never resolves
      };
      return fake;
    } as unknown as new (opts: FakeOpts) => FakeSerialPort;
    const t = new SerialTransport({ path: '/dev/ttyUSB0', baudRate: 38400 }, Ctor as never);
    await t.open();
    const sendPromise = t.send([0x01]);
    // Simulate underlying-port close arriving mid-flight.
    fake.emit('close');
    await assert.rejects(() => sendPromise, DeviceClosedError);
  });

  test('11) constructor opts include 38400 default + 8-N-1 + no flow control + autoOpen=false', () => {
    let captured!: FakeOpts;
    const Ctor = function (opts: FakeOpts) {
      captured = opts;
      return new FakeSerialPort(opts);
    } as unknown as new (opts: FakeOpts) => FakeSerialPort;
    new SerialTransport({ path: '/dev/ttyUSB0' }, Ctor as never);
    assert.strictEqual(captured.path, '/dev/ttyUSB0');
    assert.strictEqual(captured.baudRate, 38400);
    assert.strictEqual(captured.dataBits, 8);
    assert.strictEqual(captured.stopBits, 1);
    assert.strictEqual(captured.parity, 'none');
    assert.strictEqual(captured.autoOpen, false);
  });
});
