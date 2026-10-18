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
  /** Requests left per 'card:page' that get no reply at all. */
  silent: Record<string, number> = {};
  /** ACK writes left that fail (a serial write error). */
  failAcks = 0;
  /** The n-th ACK's write (1-based) drains until `release()`. */
  holdAckAt = 0;
  private acks = 0;
  private held: Promise<void> | undefined;
  release: () => void = () => undefined;
  /** The write being sent now drains until `release()`; later writes wait. */
  holdWrite(): void {
    this.held = new Promise((resolve) => {
      this.release = () => {
        this.held = undefined;
        resolve();
      };
    });
  }
  send(bytes: number[]): Promise<void> {
    if (bytes.length === 1 && bytes[0] === proto.ACK && this.failAcks > 0) {
      this.failAcks--;
      this.note('ACK write failed');
      return Promise.reject(new Error('write failed'));
    }
    if (bytes.length === 1 && bytes[0] === proto.ACK && ++this.acks === this.holdAckAt) {
      this.holdWrite();
    }
    this.answer(bytes);
    return this.held ?? Promise.resolve();
  }
  inject(bytes: number[]): void {
    setImmediate(() => this.emit('data', bytes));
  }
  private answer(bytes: number[]): void {
    if (bytes.length === 1 && bytes[0] === proto.ACK) {
      this.note('ACK');
      return;
    }
    if (bytes[2] !== proto.cmd.GET_SI8) return this.inject([proto.NAK]); // eg readCards' SET_MS
    const p = bytes[4]!;
    const card = this.onStation;
    this.note(`GET p${p} ${card ?? '-'}`);
    if (!card) return this.inject([proto.NAK]);
    if ((this.naks[`${card}:${p}`] ?? 0) > 0) {
      this.naks[`${card}:${p}`]!--;
      return this.inject([proto.NAK]);
    }
    if ((this.silent[`${card}:${p}`] ?? 0) > 0) {
      this.silent[`${card}:${p}`]!--;
      return; // no reply at all
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
  waitMs = 200,
  silent: Record<string, number> = {}
): Promise<{
  read: number[];
  cards: BaseSiCard[];
  errors: string[];
  log: string[];
  at: number[];
}> => {
  const fake = new FakeStation(hooks, naks);
  fake.silent = silent;
  const station = new SiMainStation(fake);
  const read: number[] = [];
  const cards: BaseSiCard[] = [];
  const errors: string[] = [];
  station.on('cardRead', (c: BaseSiCard) => {
    read.push(c.cardNumber);
    cards.push(c);
  });
  station.on('error', (e: Error) => errors.push(e.message));
  fake.inject(det(A.cardData.cardNumber, 0x0f));
  // Far below the send timeout: nothing here may wait for it.
  await new Promise((r) => setTimeout(r, waitMs));
  await station.close();
  return { read, cards, errors, log: fake.log, at: fake.at };
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

describe('SiMainStation: the same card detected again before removal', () => {
  /** Drive one station through `steps` (bytes injected after `ms`, then
   * optionally a card change), recording station events in the fake's log. */
  const script = async (
    steps: { ms: number; bytes: number[]; card?: Card }[],
    naks: Record<string, number> = {},
    failAcks = 0
  ): Promise<string[]> => {
    const fake = new FakeStation({}, naks);
    fake.failAcks = failAcks;
    const station = new SiMainStation(fake);
    station.on('cardInserted', (c: BaseSiCard) => fake.log.push(`inserted ${c.cardNumber}`));
    station.on('cardRead', (c: BaseSiCard) => fake.log.push(`read ${c.cardNumber}`));
    station.on('error', (e: Error) => fake.log.push(`error ${e.message}`));
    for (const step of steps) {
      await new Promise((r) => setTimeout(r, step.ms));
      if (step.card !== undefined || step.bytes === REM_A) fake.onStation = step.card;
      fake.inject(step.bytes);
    }
    await new Promise((r) => setTimeout(r, 200));
    await station.close();
    return fake.log;
  };
  const DET_A = det(a, 0x0f);
  const REM_A = rem(a);
  const READ_A = ['inserted ' + a, 'GET p0 A', 'GET p4 A', 'ACK', 'read ' + a];

  test('read → DET again → only an ACK → SI_REM → DET → a new read', async () => {
    const log = await script([
      { ms: 0, bytes: DET_A },
      { ms: 100, bytes: DET_A },
      { ms: 100, bytes: REM_A },
      { ms: 100, bytes: DET_A, card: 'A' },
    ]);
    assert.deepEqual(log, [...READ_A, 'ACK', ...READ_A]);
  });

  test('a failed ACK write: no report, and the next detect reads the card again', async () => {
    const log = await script(
      [
        { ms: 0, bytes: DET_A },
        { ms: 100, bytes: DET_A },
      ],
      {},
      1
    );
    assert.deepEqual(log, [
      'inserted ' + a,
      'GET p0 A',
      'GET p4 A',
      'ACK write failed',
      'error write failed',
      ...READ_A,
    ]);
  });

  test('another card detected without SI_REM is read', async () => {
    const log = await script([
      { ms: 0, bytes: DET_A },
      { ms: 100, bytes: det(b, 0x01), card: 'B' },
    ]);
    assert.deepEqual(log, [...READ_A, 'inserted ' + b, ...B_PAGES, 'ACK', 'read ' + b]);
  });

  test('after a failed read, the same card detected again is read', async () => {
    const log = await script(
      [
        { ms: 0, bytes: DET_A },
        { ms: 1200, bytes: DET_A },
      ],
      { 'A:4': 3 }
    );
    assert.deepEqual(log, [
      'inserted ' + a,
      'GET p0 A',
      'GET p4 A',
      'GET p4 A',
      'GET p4 A',
      'error NAK',
      ...READ_A,
    ]);
  });
});

describe('SiMainStation: the same card detected again during its read', () => {
  const DET_A = det(a, 0x0f);
  /** Hold page 4's reply 60 ms; `during` sends extra detects meanwhile. */
  const holdPage4 =
    (during: (fake: FakeStation) => void): Hook =>
    (fake) => {
      during(fake);
      setTimeout(() => fake.inject(page(A.storageData as number[], 4)), 60);
      return { extra: [], next: 'A', drop: true };
    };
  const assertOneRead = (r: Awaited<ReturnType<typeof run>>): void => {
    assert.deepEqual(r.read, [a]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.log, ['GET p0 A', 'GET p4 A', 'ACK']);
  };

  test('while page 4 is pending: ignored, the read goes on, one ACK', async () => {
    assertOneRead(await run({ 'A:4': holdPage4((fake) => fake.inject(DET_A)) }));
  });

  test('in the same chunk as the page-0 reply: ignored', async () => {
    assertOneRead(await run({ 'A:0': () => ({ extra: DET_A, next: 'A' }) }));
  });

  test('three times during the read: ignored', async () => {
    assertOneRead(
      await run({
        'A:4': holdPage4((fake) => {
          for (const ms of [10, 20, 30]) setTimeout(() => fake.inject(DET_A), ms);
        }),
      })
    );
  });

  test('a new session (readCards) reads the card again', async () => {
    const fake = new FakeStation();
    const station = new SiMainStation(fake);
    const read: number[] = [];
    station.on('cardRead', (c: BaseSiCard) => read.push(c.cardNumber));
    fake.inject(DET_A);
    await new Promise((r) => setTimeout(r, 50));
    // The fake NAKs the handshake: only that a new session started matters.
    await assert.rejects(station.readCards());
    fake.inject(DET_A);
    await new Promise((r) => setTimeout(r, 50));
    await station.close();
    assert.deepEqual(read, [a, a]);
  });
});

describe('SiMainStation: an ACK queued behind a draining write', () => {
  const changeToB = (fake: FakeStation): void => {
    fake.onStation = 'B';
    fake.inject([...rem(a), ...det(b, 0x01)]);
  };

  test("A's ACK is dropped once A has left; A is reported, B is read", async () => {
    const r = await run({
      'A:4': (fake) => {
        fake.holdWrite(); // GET 4 still drains when its reply comes
        setTimeout(() => changeToB(fake), 20);
        setTimeout(() => fake.release(), 60);
        return { extra: [], next: 'A' };
      },
    });
    assert.deepEqual(r.read, [a, b]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.log, ['GET p0 A', 'GET p4 A', ...B_PAGES, 'ACK']);
  });

  test('the ACK for a repeated detect is dropped once the card has left', async () => {
    const fake = new FakeStation();
    fake.holdAckAt = 2; // the ACK for the first repeat drains; the second waits
    const station = new SiMainStation(fake);
    const read: number[] = [];
    station.on('cardRead', (c: BaseSiCard) => read.push(c.cardNumber));
    fake.inject(det(a, 0x0f));
    await new Promise((r) => setTimeout(r, 30));
    fake.inject(det(a, 0x0f));
    fake.inject(det(a, 0x0f));
    await new Promise((r) => setTimeout(r, 20));
    changeToB(fake);
    await new Promise((r) => setTimeout(r, 20));
    fake.release();
    await new Promise((r) => setTimeout(r, 100));
    await station.close();
    assert.deepEqual(read, [a, b]);
    assert.deepEqual(fake.log, ['GET p0 A', 'GET p4 A', 'ACK', 'ACK', ...B_PAGES, 'ACK']);
  });
});

describe('SiMainStation: timeout retry', () => {
  /** ms between the n-th and (n+1)-th request for `line`. */
  const gaps = (r: { log: string[]; at: number[] }, line: string): number[] => {
    const at = r.log.flatMap((l, k) => (l === line ? [r.at[k]!] : []));
    return at.slice(1).map((t, i) => Math.round(t - at[i]!));
  };
  const firstCode = (c: BaseSiCard): number | undefined =>
    (c.raceResult.punches as { code: number }[] | undefined)?.[0]?.code;

  test('no reply to page 4 once: asked again after 2.5 s, the card is read and ACKed', async () => {
    const r = await run({}, {}, 2800, { 'A:4': 1 });
    assert.deepEqual(r.read, [a]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.log, ['GET p0 A', 'GET p4 A', 'GET p4 A', 'ACK']);
    assert.ok(gaps(r, 'GET p4 A')[0]! >= 2490, `retry after ${gaps(r, 'GET p4 A')}`);
  });

  test('a late reply to the timed-out try lands on the next page request: that page is asked again', async () => {
    const r = await run(
      {
        // Page 0's first reply comes after its 2.5 s try timed out, while the
        // page-4 request (answered 50 ms late) is pending.
        'A:0': (fake) => {
          setTimeout(() => fake.inject(page(A.storageData as number[], 0)), 2520);
          return { extra: [], next: 'A', drop: true };
        },
        'A:4': (fake) => {
          setTimeout(() => fake.inject(page(A.storageData as number[], 4)), 50);
          return { extra: [], next: 'A', drop: true };
        },
      },
      {},
      2900
    );
    assert.deepEqual(r.read, [a]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.log, ['GET p0 A', 'GET p0 A', 'GET p4 A', 'GET p4 A', 'ACK']);
  });

  test('no reply ever: three tries 2.5 s, 2.5 s and 2 s, then the read fails without an ACK', async () => {
    const r = await run({}, {}, 7300, { 'A:4': 3 });
    assert.deepEqual(r.read, []);
    assert.deepEqual(r.errors, ['Send timed out after 2000ms (command 0xEF)']);
    assert.deepEqual(r.log, ['GET p0 A', 'GET p4 A', 'GET p4 A', 'GET p4 A']);
    const [g1, g2] = gaps(r, 'GET p4 A');
    assert.ok(g1! >= 2490 && g2! >= 2490, `tries ${g1} and ${g2} ms apart`);
  });

  test('noise in front of the page-4 reply: after the frame limit the reply behind it answers', async () => {
    const behind = (A.storageData as number[]).slice();
    behind[4 * 128 + 1] = 200; // marks the reply that came behind the noise
    const r = await run(
      {
        'A:4': (fake) => {
          setTimeout(() => {
            fake.onStation = 'B';
            fake.inject([...rem(a), ...det(b, 0x01)]);
          }, 1500);
          return { extra: [0x02, 0xef, 0xff, ...page(behind, 4)], next: 'A', drop: true };
        },
      },
      {},
      2000
    );
    assert.deepEqual(r.read, [a, b]);
    assert.deepEqual(r.errors, []);
    assert.equal(
      firstCode(r.cards[0]!),
      200,
      'the reply to this request, recovered before it timed out'
    );
    assert.deepEqual(r.log, ['GET p0 A', 'GET p4 A', 'ACK', ...B_PAGES, 'ACK']);
  });
});

describe('SiMainStation: an incomplete frame while no request is pending', () => {
  /** Drive the station with raw deliveries at given times; collect cards,
   * frame errors and the fake's request log. */
  const deliver = async (
    steps: { ms: number; bytes: number[] }[],
    waitMs: number
  ): Promise<{ read: number[]; frameErrors: string[]; log: string[] }> => {
    const fake = new FakeStation();
    const station = new SiMainStation(fake);
    const read: number[] = [];
    const frameErrors: string[] = [];
    station.on('cardRead', (c: BaseSiCard) => read.push(c.cardNumber));
    station.on('frameError', (e: { error_code: string }) => frameErrors.push(e.error_code));
    for (const step of steps) {
      await new Promise((r) => setTimeout(r, step.ms));
      fake.emit('data', step.bytes);
    }
    await new Promise((r) => setTimeout(r, waitMs));
    await station.close();
    return { read, frameErrors, log: fake.log };
  };
  const DET_A = det(a, 0x0f);
  const READ_A = ['GET p0 A', 'GET p4 A', 'ACK'];

  test('02 EF FF, then a card detection: after the frame time limit the card is read', async () => {
    const r = await deliver(
      [
        { ms: 0, bytes: [0x02, 0xef, 0xff] },
        { ms: 50, bytes: DET_A },
      ],
      1300
    );
    assert.deepEqual(r.read, [a]);
    assert.deepEqual(r.frameErrors, ['truncated']);
    assert.deepEqual(r.log, READ_A);
  });

  test('an STX inside the dropped bytes is no resync point unless a whole frame starts there', async () => {
    const fakeDet = [0x02, 0xe8, 0x06, 0x00, 0x0a, 0x0f, 0x99, 0x99, 0x99, 0x00, 0x00, 0x03]; // bad CRC
    const r = await deliver(
      [
        { ms: 0, bytes: [0x02, 0xef, 0xff, ...fakeDet] },
        { ms: 50, bytes: DET_A },
      ],
      1300
    );
    assert.deepEqual(r.read, [a], 'only the real card, never 0x999999');
    assert.deepEqual(r.log, READ_A);
  });

  test("noise whose fake length ends on the detection's ETX: the card is still read", async () => {
    // 02 EF 09 claims 9 bytes, so its CRC and "ETX" are the end of DET_A.
    const r = await deliver([{ ms: 0, bytes: [0x02, 0xef, 0x09, ...DET_A] }], 200);
    assert.deepEqual(r.read, [a]);
    assert.deepEqual(r.frameErrors, ['crc_mismatch']);
    assert.deepEqual(r.log, READ_A);
  });

  test('a detection in three slow deliveries (within the limit) is read at once', async () => {
    const r = await deliver(
      [
        { ms: 0, bytes: DET_A.slice(0, 1) },
        { ms: 300, bytes: DET_A.slice(1, 6) },
        { ms: 300, bytes: DET_A.slice(6) },
      ],
      100
    );
    assert.deepEqual(r.read, [a]);
    assert.deepEqual(r.frameErrors, []);
    assert.deepEqual(r.log, READ_A);
  });

  test('parts more than the limit apart: the head is dropped as truncated', async () => {
    const r = await deliver(
      [
        { ms: 0, bytes: DET_A.slice(0, 6) },
        { ms: 1200, bytes: DET_A.slice(6) },
      ],
      100
    );
    assert.deepEqual(r.read, []);
    assert.deepEqual(r.frameErrors, ['truncated']);
  });
});
