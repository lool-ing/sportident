// Authored for lool. Not ported from upstream.
//
// --baud handling: the station only answers when the port runs at the rate
// the station is set to; at any other rate it hears garbage and stays silent.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { SerialTransport } from '../transport/SerialTransport.ts';
import { SendTimeoutError } from '../transport/errors.ts';
import { initialBaud, parseBaud, readCardsAtBaud } from './baud.ts';
import { parseArgs } from './lool-readout.ts';
import { parseTrainerArgs } from './lool-trainer.ts';

// A port whose station answers every write, but only while the port runs at
// `answerAt` baud (null: a station that never answers).
const makeTransport = (answerAt: number | null, baudRate?: number) => {
  const rates: number[] = [];
  class FakePort extends EventEmitter {
    baud: number;
    constructor(o: { baudRate?: number }) {
      super();
      this.baud = o.baudRate ?? 0;
      rates.push(this.baud);
    }
    open(cb: (e: Error | null) => void) {
      setImmediate(() => cb(null));
    }
    write(_b: Buffer, cb: (e: Error | null) => void) {
      setImmediate(() => {
        cb(null);
        if (this.baud === answerAt) this.emit('data', Buffer.from([0x02]));
      });
      return true;
    }
    drain(cb: (e: Error | null) => void) {
      setImmediate(() => cb(null));
    }
    update(o: { baudRate: number }, cb: (e: Error | null) => void) {
      this.baud = o.baudRate;
      rates.push(o.baudRate);
      setImmediate(() => cb(null));
    }
    close(cb: (e: Error | null) => void) {
      setImmediate(() => cb(null));
    }
  }
  const transport = new SerialTransport(
    { path: '/dev/ttyUSB9', ...(baudRate ? { baudRate } : {}) },
    FakePort as never
  );
  // Stand-in for SiMainStation.readCards(): one SET_MS-like send, no answer in
  // 30 ms is the same SendTimeoutError the real station raises after 2 s.
  const readCards = () =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new SendTimeoutError(0xf0, 2000)), 30);
      transport.once('data', () => {
        clearTimeout(t);
        resolve();
      });
      void transport.send([0xf0]);
    });
  return { transport, readCards, rates };
};

const run = (baud: 38400 | 4800 | 'auto', t: ReturnType<typeof makeTransport>) =>
  readCardsAtBaud({ ...t, path: '/dev/ttyUSB9', baud });

describe('readCardsAtBaud', () => {
  test('default 38400 against a 4800 station fails and says what to try', async () => {
    const t = makeTransport(4800);
    await assert.rejects(run(38400, t), (err: Error) => {
      assert.match(err.message, /\/dev\/ttyUSB9/);
      assert.match(err.message, /38400 baud/);
      assert.match(err.message, /--baud 4800/);
      assert.match(err.message, /--baud auto/);
      assert.match(err.message, /Send timed out after 2000ms \(command 0xF0\)/);
      assert.ok(err.cause instanceof SendTimeoutError);
      return true;
    });
  });

  test('--baud 4800 handshakes against a 4800 station', async () => {
    const t = makeTransport(4800, initialBaud(4800));
    assert.strictEqual(await run(4800, t), 4800);
  });

  test('auto retries at 4800 once and reports 4800', async () => {
    const t = makeTransport(4800, initialBaud('auto'));
    assert.strictEqual(await run('auto', t), 4800);
    assert.deepStrictEqual(t.rates, [38400, 4800]);
  });

  test('auto against a silent station names both rates', async () => {
    const t = makeTransport(null, initialBaud('auto'));
    await assert.rejects(run('auto', t), (err: Error) => {
      assert.match(err.message, /\/dev\/ttyUSB9/);
      assert.match(err.message, /38400 and 4800 baud/);
      assert.match(err.message, /Send timed out/);
      return true;
    });
    assert.deepStrictEqual(t.rates, [38400, 4800]);
  });

  test('errors other than a timeout pass through untouched', async () => {
    const t = makeTransport(4800);
    const boom = new Error('boom');
    await assert.rejects(
      readCardsAtBaud({ ...t, readCards: () => Promise.reject(boom), path: 'x', baud: 'auto' }),
      boom
    );
  });
});

describe('--baud parsing', () => {
  test('parseBaud accepts 38400, 4800 and auto', () => {
    assert.strictEqual(parseBaud('38400'), 38400);
    assert.strictEqual(parseBaud('4800'), 4800);
    assert.strictEqual(parseBaud('auto'), 'auto');
  });

  test('parseBaud rejects other values', () => {
    assert.throws(() => parseBaud('9600'), /--baud must be 38400, 4800 or auto \(got: 9600\)/);
  });

  test('lool-readout and lool-trainer take --baud, default 38400', () => {
    assert.strictEqual(parseArgs([]).baud, 38400);
    assert.strictEqual(parseArgs(['--baud', '4800']).baud, 4800);
    assert.strictEqual(parseArgs(['--baud=auto']).baud, 'auto');
    assert.throws(() => parseArgs(['--baud', '9600']), /--baud must be/);
    assert.strictEqual(parseTrainerArgs([]).baud, 38400);
    assert.strictEqual(parseTrainerArgs(['--baud', '4800']).baud, 4800);
    assert.strictEqual(parseTrainerArgs(['--baud=auto']).baud, 'auto');
    assert.throws(() => parseTrainerArgs(['--baud', '9600']), /--baud must be/);
  });
});
