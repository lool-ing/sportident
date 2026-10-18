// Authored for lool. Not ported from upstream.
// A detection for a card number outside every supported range is reported as
// 'cardUnsupported': no page request, no ACK, no read. SI_REM still gives
// 'cardRemoved' and the next supported card is read as usual.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { render } from '../siProtocol.ts';
import { proto } from '../constants.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { SiMainStation } from './SiMainStation.ts';

import { fixture as A } from '../../tests/fixtures/upstream/si10-typical.ts';

const frame = (command: number, parameters: number[]): number[] => render({ command, parameters });
const numBytes = (n: number): number[] => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const det = (n: number, series = 0x0f): number[] =>
  frame(proto.cmd.SI8_DET, [0, 0, series, ...numBytes(n)]);
const rem = (n: number): number[] => frame(proto.cmd.SI_REM, [0, 0, 0x0f, ...numBytes(n)]);
const storage = [...(A.storageData as number[]), ...new Array<number>(1024).fill(0xee)];

/** Answers GET_SI8 from the SI10 fixture; every write is logged. */
class FakeStation extends EventEmitter implements ISerialTransport {
  log: string[] = [];
  open(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  inject(bytes: number[]): void {
    setImmediate(() => this.emit('data', bytes));
  }
  send(bytes: number[]): Promise<void> {
    if (bytes.length === 1 && bytes[0] === proto.ACK) this.log.push('ACK');
    else if (bytes[2] === proto.cmd.GET_SI8) {
      const p = bytes[4]!;
      this.log.push(`GET p${p}`);
      this.inject(
        frame(proto.cmd.GET_SI8, [0x00, 0x0a, p, ...storage.slice(p * 128, p * 128 + 128)])
      );
    } else this.log.push('other');
    return Promise.resolve();
  }
}

const a = A.cardData.cardNumber as number;
const tick = (ms = 80): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

describe('SiMainStation: unsupported card numbers', () => {
  for (const n of [4_000_123, 6_000_123, 3_500_000, 16_777_215]) {
    test(`${n}: cardUnsupported once, nothing sent; SI_REM -> cardRemoved; next card is read`, async () => {
      const fake = new FakeStation();
      const station = new SiMainStation(fake);
      const events: string[] = [];
      const unsupported: unknown[] = [];
      station.on('cardUnsupported', (u: unknown) => unsupported.push(u));
      station.on('cardInserted', () => events.push('inserted'));
      station.on('cardRemoved', (c: number) => events.push(`removed ${c}`));
      station.on('cardRead', (c: { cardNumber: number }) => events.push(`read ${c.cardNumber}`));
      station.on('error', (e: Error) => events.push(`error ${e.message}`));

      fake.inject(det(n, 0x0f));
      await tick();
      assert.deepEqual(unsupported, [
        { cardNumber: n, command: proto.cmd.SI8_DET, seriesByte: 0x0f },
      ]);
      assert.deepEqual(fake.log, []);
      assert.deepEqual(events, []);

      fake.inject(rem(n));
      await tick();
      fake.inject(det(a, 0x0f));
      await tick();
      await station.close();
      assert.deepEqual(events, [`removed ${n}`, 'inserted', `read ${a}`]);
      assert.equal(unsupported.length, 1);
      assert.deepEqual(fake.log, ['GET p0', 'GET p4', 'ACK']);
    });
  }

  test('SI5_DET and SI6_DET: no series byte in the event', async () => {
    const fake = new FakeStation();
    const station = new SiMainStation(fake);
    const unsupported: unknown[] = [];
    station.on('cardUnsupported', (u: unknown) => unsupported.push(u));
    fake.inject(frame(proto.cmd.SI5_DET, [0, 0, 0, ...numBytes(3_500_000)]));
    fake.inject(frame(proto.cmd.SI6_DET, [0, 0, 0, ...numBytes(3_500_000)]));
    await tick();
    await station.close();
    assert.deepEqual(unsupported, [
      { cardNumber: 3_500_000, command: proto.cmd.SI5_DET },
      { cardNumber: 3_500_000, command: proto.cmd.SI6_DET },
    ]);
  });

  test('a read card, an unsupported one, SI_REM, then the first again: read again', async () => {
    const fake = new FakeStation();
    const station = new SiMainStation(fake);
    const events: string[] = [];
    station.on('cardRead', (c: { cardNumber: number }) => events.push(`read ${c.cardNumber}`));
    station.on('cardUnsupported', () => events.push('unsupported'));
    fake.inject(det(a));
    await tick();
    fake.inject(det(4_000_123));
    await tick();
    fake.inject(rem(4_000_123));
    fake.inject(det(a));
    await tick();
    await station.close();
    assert.deepEqual(events, [`read ${a}`, 'unsupported', `read ${a}`]);
  });
});
