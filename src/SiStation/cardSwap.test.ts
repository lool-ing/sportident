// Authored for lool. Not ported from upstream.
// Card pulled or swapped mid-read when several frames come in ONE data chunk:
// the page reply plus SI_REM (and the next card's SI8_DET). The old read must
// not send more requests, take the next card's pages, or ACK during its read.
// A fake station answers GET_SI8 from the card on it and NAKs with none.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { render } from '../siProtocol.ts';
import { proto } from '../constants.ts';
import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { SiMainStation } from './SiMainStation.ts';

import { fixture as A } from '../../tests/fixtures/upstream/si10-typical.ts';
import { fixture as B } from '../../tests/fixtures/upstream/si9-typical.ts';

const frame = (command: number, parameters: number[]): number[] => render({ command, parameters });
const det = (n: number, series: number): number[] =>
  frame(proto.cmd.SI8_DET, [0, 0, series, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const rem = (n: number): number[] =>
  frame(proto.cmd.SI_REM, [0, 0, 0x0f, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
// Pad to 8 pages so every page a modern card asks for exists.
const pad = (s: number[]): number[] => [
  ...s,
  ...new Array<number>(Math.max(0, 1024 - s.length)).fill(0xee),
];
const page = (storage: number[], p: number): number[] =>
  frame(proto.cmd.GET_SI8, [0x00, 0x0a, p, ...pad(storage).slice(p * 128, p * 128 + 128)]);

type Card = 'A' | 'B' | undefined;
/** Fires when that card's page is answered: `extra` goes in the SAME chunk as
 * the reply (or instead of it with `drop`), then `next` is on the station. */
type Hook = (fake: FakeStation) => { extra: number[]; next: Card; drop?: boolean };

class FakeStation extends EventEmitter implements ISerialTransport {
  log: string[] = [];
  /** When each `log` entry was written (ms). */
  at: number[] = [];
  onStation: Card = 'A';
  hooks: Record<string, Hook>;
  /** NAKs left per 'card:page', for a card that stays on the station. */
  naks: Record<string, number>;
  constructor(hooks: Record<string, Hook> = {}, naks: Record<string, number> = {}) {
    super();
    this.hooks = hooks;
    this.naks = naks;
  }
  private note(line: string): void {
    this.log.push(line);
    this.at.push(performance.now());
  }
  open(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  send(bytes: number[]): Promise<void> {
    this.answer(bytes);
    return Promise.resolve();
  }
  inject(bytes: number[]): void {
    setImmediate(() => this.emit('data', bytes));
  }
  private answer(bytes: number[]): void {
    if (bytes.length === 1 && bytes[0] === proto.ACK) {
      this.note('ACK');
      return;
    }
    if (bytes[2] !== proto.cmd.GET_SI8) return;
    const p = bytes[4]!;
    const card = this.onStation;
    this.note(`GET p${p} ${card ?? '-'}`);
    if (!card) return this.inject([proto.NAK]);
    if ((this.naks[`${card}:${p}`] ?? 0) > 0) {
      this.naks[`${card}:${p}`]!--;
      return this.inject([proto.NAK]);
    }
    let out = page((card === 'A' ? A.storageData : B.storageData) as number[], p);
    const hook = this.hooks[`${card}:${p}`];
    if (hook) {
      delete this.hooks[`${card}:${p}`];
      const h = hook(this);
      out = h.drop ? h.extra : [...out, ...h.extra];
      this.onStation = h.next;
    }
    if (out.length) this.inject(out);
  }
}

const run = async (
  hooks: Record<string, Hook>,
  naks: Record<string, number> = {},
  waitMs = 200
): Promise<{ read: number[]; errors: string[]; log: string[]; at: number[] }> => {
  const fake = new FakeStation(hooks, naks);
  const station = new SiMainStation(fake);
  const read: number[] = [];
  const errors: string[] = [];
  station.on('cardRead', (c: BaseSiCard) => read.push(c.cardNumber));
  station.on('error', (e: Error) => errors.push(e.message));
  fake.inject(det(A.cardData.cardNumber, 0x0f));
  // Far below the send timeout: nothing here may wait for it.
  await new Promise((r) => setTimeout(r, waitMs));
  await station.close();
  return { read, errors, log: fake.log, at: fake.at };
};

const a = A.cardData.cardNumber;
const b = B.cardData.cardNumber;
const swapTo = (): ReturnType<Hook> => ({ extra: [...rem(a), ...det(b, 0x01)], next: 'B' });
/** B read alone: SI9 asks for pages 0 and 1. */
const B_PAGES = ['GET p0 B', 'GET p1 B'];
/** Exactly one ACK, after the last page request. */
const assertOneAckAtEnd = (log: string[]): void => {
  assert.deepEqual(
    log.filter((l) => l === 'ACK'),
    ['ACK']
  );
  assert.equal(log.at(-1), 'ACK');
};

describe('SiMainStation: card pulled or swapped, frames in one chunk', () => {
  test('page-0 reply + SI_REM(A) + DET(B): A is not reported with B pages', async () => {
    const r = await run({ 'A:0': swapTo });
    assert.deepEqual(r.read, [b]);
    assert.deepEqual(r.errors, ['card removed during read']);
    assert.deepEqual(r.log, ['GET p0 A', ...B_PAGES, 'ACK']);
  });

  test('page-0 reply + SI_REM(A): no request after the removal', async () => {
    const r = await run({ 'A:0': () => ({ extra: rem(a), next: undefined }) });
    assert.deepEqual(r.read, []);
    assert.deepEqual(r.errors, ['card removed during read']);
    assert.deepEqual(r.log, ['GET p0 A']);
  });

  test("last page + SI_REM(A) + DET(B): A is reported, no ACK for A during B's read", async () => {
    const r = await run({ 'A:4': swapTo });
    assert.deepEqual(r.read, [a, b]);
    assert.deepEqual(r.errors, []);
    assertOneAckAtEnd(r.log);
  });

  test('NAK + SI_REM(A) + DET(B) while page 4 is pending: only B is read', async () => {
    const r = await run({
      'A:4': () => ({ extra: [proto.NAK, ...rem(a), ...det(b, 0x01)], next: 'B', drop: true }),
    });
    assert.deepEqual(r.read, [b]);
    assert.equal(r.errors.length, 1);
    assertOneAckAtEnd(r.log);
  });
});

describe('SiMainStation: NAK retry', () => {
  /** ms between the first two requests for `line`. */
  const gap = (r: { log: string[]; at: number[] }, line: string): number => {
    const [i, j] = r.log.flatMap((l, k) => (l === line ? [k] : []));
    return r.at[j!]! - r.at[i!]!;
  };

  test('one NAK on a page: asked again 500 ms later, the card is read and ACKed', async () => {
    const r = await run({}, { 'A:4': 1 }, 800);
    assert.deepEqual(r.read, [a]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.log, ['GET p0 A', 'GET p4 A', 'GET p4 A', 'ACK']);
    assert.ok(gap(r, 'GET p4 A') >= 490, `retry after ${gap(r, 'GET p4 A')} ms`);
  });

  test('NAK every time: three tries, then the read fails without an ACK', async () => {
    const r = await run({}, { 'A:4': 3 }, 1300);
    assert.deepEqual(r.read, []);
    assert.deepEqual(r.errors, ['NAK']);
    assert.deepEqual(r.log, ['GET p0 A', 'GET p4 A', 'GET p4 A', 'GET p4 A']);
  });

  test('NAK, then SI_REM during the wait: no retry, the read fails at once', async () => {
    const r = await run({
      'A:4': (fake) => {
        setTimeout(() => fake.inject(rem(a)), 50);
        return { extra: [proto.NAK], next: undefined, drop: true };
      },
    });
    assert.deepEqual(r.read, []);
    assert.deepEqual(r.errors, ['card removed during read']);
    assert.deepEqual(r.log, ['GET p0 A', 'GET p4 A']);
  });
});
