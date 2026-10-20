// Authored for lool. Not ported from upstream.
// Opt-in SIAC battery measurement (SiMainStation measureSiacBattery): the
// write to page 0x7E goes between block 0 and block 3, block 3 then holds the
// new voltage, and a NAK, no reply or a pulled card never costs the read more
// than the measurement. A fake station answers from a synthetic SIAC image.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { render } from '../siProtocol.ts';
import { proto } from '../constants.ts';
import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { SiMainStation } from './SiMainStation.ts';

import { fixture as siac } from '../../tests/fixtures/upstream/siac-typical.ts';

const frame = (command: number, parameters: number[]): number[] => render({ command, parameters });
const card = siac.cardData.cardNumber as number;
const id = [(card >> 16) & 0xff, (card >> 8) & 0xff, card & 0xff];
const det = frame(proto.cmd.SI8_DET, [0, 0, 0x0f, ...id]);
const rem = frame(proto.cmd.SI_REM, [0, 0, 0x0f, ...id]);
const BATTERY = 0x1c7;

type Measure = 'reply' | 'nak' | 'silent' | 'pull';

class FakeStation extends EventEmitter implements ISerialTransport {
  log: string[] = [];
  /** When each `log` entry was written (ms). */
  at: number[] = [];
  /** Battery byte n (1.9 V + n × 0.09 V): stored, and after a measurement. */
  private image = [
    ...(siac.storageData as number[]),
    ...new Array<number>(Math.max(0, 1024 - siac.storageData.length)).fill(0xee),
  ];
  private onStation = true;
  private readonly measure: Measure;
  constructor(measure: Measure) {
    super();
    this.measure = measure;
    this.image[BATTERY] = 10;
  }
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
    const before = this.log.length;
    this.answer(bytes);
    if (this.log.length > before) this.at.push(performance.now());
    return Promise.resolve();
  }
  private answer(bytes: number[]): void {
    if (bytes.length === 1 && bytes[0] === proto.ACK) {
      this.log.push('ACK');
    } else if (bytes[2] === proto.cmd.SET_SI8) {
      this.log.push(`SET ${bytes.slice(4, 9).join(' ')}`);
      if (this.measure === 'nak') this.inject([proto.NAK]);
      if (this.measure === 'reply' || this.measure === 'pull') {
        this.image[BATTERY] = 12;
        const reply = frame(proto.cmd.SET_SI8, [0x00, 0x0a, 0x7e]);
        this.inject(this.measure === 'pull' ? [...reply, ...rem] : reply);
        if (this.measure === 'pull') this.onStation = false;
      }
    } else if (bytes[2] === proto.cmd.GET_SI8) {
      const p = bytes[4]!;
      this.log.push(`GET p${p}`);
      if (!this.onStation) this.inject([proto.NAK]);
      else
        this.inject(
          frame(proto.cmd.GET_SI8, [0x00, 0x0a, p, ...this.image.slice(p * 128, p * 128 + 128)])
        );
    }
  }
}

const run = async (measure: Measure, opts: { measureSiacBattery?: boolean }, waitMs = 400) => {
  const fake = new FakeStation(measure);
  const station = new SiMainStation(fake, opts);
  const read: BaseSiCard[] = [];
  const errors: string[] = [];
  station.on('cardRead', (c: BaseSiCard) => read.push(c));
  station.on('error', (e: Error) => errors.push(e.message));
  fake.inject(det);
  await new Promise((r) => setTimeout(r, waitMs));
  await station.close();
  return { read, errors, log: fake.log, at: fake.at };
};

const MEASURE = 'SET 126 5 5 5 5';
const battery = (c: BaseSiCard | undefined) => c?.raceResult.batteryMillivolts;

describe('SiMainStation: SIAC battery measurement', () => {
  test('off by default: no write to the card, the stored voltage is read', async () => {
    const r = await run('reply', {});
    assert.ok(!r.log.some((l) => l.startsWith('SET')));
    assert.equal(battery(r.read[0]), 1900 + 10 * 90);
  });

  test('on: measure after block 0, block 3 at least 100 ms later gives the new voltage', async () => {
    const r = await run('reply', { measureSiacBattery: true });
    assert.deepEqual(r.log.slice(0, 3), ['GET p0', MEASURE, 'GET p3']);
    assert.ok(r.at[2]! - r.at[1]! >= 95, `block 3 ${r.at[2]! - r.at[1]!} ms after the measurement`);
    assert.equal(r.log.at(-1), 'ACK');
    assert.equal(battery(r.read[0]), 1900 + 12 * 90);
    assert.deepEqual(r.errors, []);
  });

  test('a NAK is not repeated; the read goes on with the stored voltage', async () => {
    const r = await run('nak', { measureSiacBattery: true });
    assert.deepEqual(
      r.log.filter((l) => l === MEASURE),
      [MEASURE]
    );
    assert.equal(battery(r.read[0]), 1900 + 10 * 90);
    assert.equal(r.log.at(-1), 'ACK');
  });

  test('no reply: one try of 1000 ms, then the read goes on', async () => {
    const r = await run('silent', { measureSiacBattery: true }, 1_400);
    assert.deepEqual(
      r.log.filter((l) => l === MEASURE),
      [MEASURE]
    );
    assert.equal(r.read.length, 1);
    assert.equal(r.log.at(-1), 'ACK');
  });

  test('card pulled after the measurement: nothing more is sent, no ACK', async () => {
    const r = await run('pull', { measureSiacBattery: true });
    assert.deepEqual(r.log, ['GET p0', MEASURE]);
    assert.deepEqual(r.read, []);
    assert.deepEqual(r.errors, ['card removed during read']);
  });
});
