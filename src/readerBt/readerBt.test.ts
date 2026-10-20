// Authored for lool. Not ported from upstream.
// Reader BT framing, reassembly, readout decoding and the client's pull
// model, over a fake GATT link. Messages are built by hand from the
// published layout; card numbers are made up.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  decodeReadout,
  encodeMessage,
  READER_BT_MSG,
  READER_BT_UUID,
  Reassembler,
  toRaceResult,
  type ReaderBtReadout,
} from './messages.ts';
import { ReaderBt, type GattLink } from './ReaderBt.ts';
import { toHalfDayClock } from '../output/ndjson.ts';
import { dayOfWeekFromRaw } from '../siProtocol.ts';

const fixture = join(
  import.meta.dirname,
  '..',
  '..',
  'tests',
  'fixtures',
  'synthetic',
  'reader-bt-segmented-readout.hex'
);
const notifications = (): Uint8Array[] =>
  readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => Uint8Array.from(l.trim().split(/\s+/), (h) => parseInt(h, 16)));

const u16 = (n: number) => [n & 0xff, n >> 8];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];

const readout = (card: number, punches: [type: number, code: number, ms: number][] = []) =>
  encodeMessage(READER_BT_MSG.cardReadoutMinimal, [
    ...u32(card),
    15,
    ...u16(punches.length),
    ...punches.flatMap(([type, code, ms]) => [0, type, ...u16(code), ...u32(ms)]),
  ]);
const cardState = (card: number, inserted: boolean) =>
  encodeMessage(READER_BT_MSG.cardStateChange, [...u32(card), inserted ? 1 : 0, ...u16(1)]);
const segment = (flag: number, bytes: number[]) =>
  encodeMessage(READER_BT_MSG.segment, [flag, ...bytes]);

const reassemble = (packets: Uint8Array[]) => {
  const r = new Reassembler();
  return packets.map((p) => r.push(p));
};

describe('Reader BT reassembly', () => {
  test('four segments of the fixture make one 75-byte readout', () => {
    const results = reassemble(notifications());
    assert.deepEqual(results.slice(0, 3), [null, null, null]);
    const last = results[3];
    assert.ok(last && 'message' in last);
    assert.equal(last.message.length, 75);
    assert.equal(decodeReadout(last.message).cardNumber, 8123456);
  });

  test('a whole message passes through unchanged', () => {
    const m = readout(1234567);
    assert.deepEqual(reassemble([m]), [{ message: m }]);
  });

  test('a whole message inside a segmented one is kept; the half one is lost', () => {
    const m = [...readout(1234567)];
    const whole = readout(7654321);
    const results = reassemble([
      segment(1, [...u32(m.length), ...m.slice(0, 5)]),
      whole,
      segment(2, m.slice(5)),
    ]);
    assert.deepEqual(results, [
      null,
      { message: whole },
      { error: 'segment flag 2 without a first segment' },
    ]);
  });

  test('a continuation without a first segment is an error', () => {
    assert.deepEqual(reassemble([segment(0, [1, 2])]), [
      { error: 'segment flag 0 without a first segment' },
    ]);
  });

  test('a first segment mid-message restarts, and the restarted message completes', () => {
    const m = [...readout(1234567)];
    const results = reassemble([
      segment(1, [...u32(m.length), ...m.slice(0, 5)]),
      segment(1, [...u32(m.length), ...m.slice(0, 5)]),
      segment(2, m.slice(5)),
    ]);
    assert.equal(results[0], null);
    assert.deepEqual(results[1], { error: 'segmented message restarted' });
    assert.deepEqual(results[2], { message: Uint8Array.from(m) });
  });

  test('a last segment short of the total length is dropped', () => {
    const m = [...readout(1234567)];
    const results = reassemble([
      segment(1, [...u32(m.length), ...m.slice(0, 5)]),
      segment(2, m.slice(5, -1)),
    ]);
    assert.deepEqual(results[1], { error: 'segments do not add up to the total length' });
  });

  test('a header whose length disagrees with the bytes is an error', () => {
    const m = readout(1234567);
    const results = reassemble([m.subarray(0, m.length - 1)]);
    assert.ok(results[0] && 'error' in results[0]);
  });
});

describe('Reader BT readout', () => {
  const fixtureReadout = (): ReaderBtReadout => {
    const last = reassemble(notifications())[3];
    assert.ok(last && 'message' in last);
    return decodeReadout(last.message);
  };

  test('decodes card, family and every punch record', () => {
    const r = fixtureReadout();
    assert.equal(r.cardFamily, 15);
    assert.deepEqual(
      r.punches.map((p) => [p.type, p.code]),
      [
        [1, 0],
        [2, 10],
        [3, 1],
        [7, 31],
        [7, 32],
        [7, 33],
        [5, 2],
        [6, 2],
      ]
    );
  });

  test('the stored bytes decode to the same readout', () => {
    const r = fixtureReadout();
    assert.deepEqual(decodeReadout(r.bytes), r);
  });

  test('a punch count that does not fit the payload is rejected', () => {
    const m = readout(1234567, [[7, 31, 0]]);
    m[9] = 2; // punch_count low byte
    assert.throws(() => decodeReadout(m), /2 punches do not fit/);
  });

  test('maps to the serial decoders’ race result', () => {
    const rr = toRaceResult(fixtureReadout());
    assert.equal(rr.cardNumber, 8123456);
    assert.equal(rr.clearTime, 36000);
    assert.deepEqual([rr.checkTime, rr.checkCode], [36005, 10]);
    assert.deepEqual([rr.startTime, rr.startCode, rr.startSubsec256], [36930, 1, 128]);
    assert.deepEqual([rr.finishTime, rr.finishCode, rr.finishSubsec256], [49510, 2, 64]);
    assert.deepEqual([rr.finishFirstTime, rr.finishFirstCode], [49509, 2]);
    assert.equal(rr.finishFirstSubsec256, undefined);
    assert.deepEqual(rr.punches, [
      { code: 31, time: 37200, weekdayRaw: 2 },
      { code: 32, time: 47107, weekdayRaw: 2 },
      { code: 33, time: 48600, weekdayRaw: 2 },
    ]);
  });

  test('a week time of Tuesday 03:04:05 is Tuesday at 03:04:05 AM', () => {
    const rr = toRaceResult(
      decodeReadout(readout(1234567, [[7, 31, 2 * 86_400_000 + 11_045_000]]))
    );
    const p = rr.punches![0]!;
    assert.deepEqual(toHalfDayClock(p.time, null, undefined, p.weekdayRaw), {
      seconds_in_half_day: 11045,
      half_day: 0,
      weekday: 2,
      weekday_raw: 2,
    });
  });

  test('complete SIAC readout: battery data decoded, owner data zeroed in the stored bytes', () => {
    const owner = [...new TextEncoder().encode('\u0001Ann;Example;')];
    const production = [43, 43, ...u16(120), ...u16(7), ...u16(2980), 24, 3, 15, 20, 11];
    const m = encodeMessage(READER_BT_MSG.cardReadoutComplete, [
      ...u32(8123456),
      15,
      ...u16(1),
      0,
      7,
      ...u16(31),
      ...u32(1000),
      ...production,
      ...owner,
    ]);
    const r = decodeReadout(m);
    assert.deepEqual(r.battery, {
      batteryMillivolts: 2980,
      hardwareVersion: '4.3',
      softwareVersion: '4.3',
      batteryDate: '2024-03-15',
    });
    const ownerAt = m.length - owner.length;
    assert.deepEqual([...r.bytes.subarray(0, ownerAt)], [...m.subarray(0, ownerAt)]);
    assert.ok(r.bytes.subarray(ownerAt).every((b) => b === 0));
    assert.deepEqual(decodeReadout(r.bytes), r);
    const rr = toRaceResult(r);
    assert.deepEqual(
      [rr.batteryMillivolts, rr.hardwareVersion, rr.softwareVersion, rr.batteryDate],
      [2980, '4.3', '4.3', '2024-03-15']
    );
  });

  test('complete readout of another card: no battery data, everything after the punches zeroed', () => {
    const m = encodeMessage(READER_BT_MSG.cardReadoutComplete, [
      ...u32(1234567),
      1,
      ...u16(0),
      1,
      65,
      66,
      0,
    ]);
    const r = decodeReadout(m);
    assert.equal(r.battery, undefined);
    assert.deepEqual([...r.bytes.subarray(11)], [0, 0, 0, 0]);
  });

  test('a time past Saturday has no day of week', () => {
    const rr = toRaceResult(decodeReadout(readout(1234567, [[7, 31, 7 * 86_400_000]])));
    assert.equal(dayOfWeekFromRaw(rr.punches![0]!.weekdayRaw!), null);
  });
});

/** Fake link: records writes, lets the test deliver notifications. */
class FakeLink implements GattLink {
  writes: { characteristic: string; bytes: number[] }[] = [];
  private subs = new Map<string, (b: Uint8Array) => void>();
  private disconnect: (() => void) | undefined;
  failWrites = false;

  async write(characteristic: string, bytes: Uint8Array): Promise<void> {
    if (this.failWrites) throw new Error('GATT write failed');
    this.writes.push({ characteristic, bytes: [...bytes] });
  }
  async subscribe(characteristic: string, onValue: (b: Uint8Array) => void): Promise<void> {
    this.subs.set(characteristic, onValue);
  }
  onDisconnect(listener: () => void): void {
    this.disconnect = listener;
  }
  notify(characteristic: string, bytes: Uint8Array): void {
    this.subs.get(characteristic)!(bytes);
  }
  dropConnection(): void {
    this.disconnect!();
  }
}

const REQUEST = [...encodeMessage(READER_BT_MSG.cardReadoutMinimal)];
/** A SIAC gets the complete readout, for its battery data. */
const REQUEST_SIAC = [...encodeMessage(READER_BT_MSG.cardReadoutComplete)];
const FEEDBACK_OK = [...encodeMessage(READER_BT_MSG.feedback, [1])];

const setup = async () => {
  const link = new FakeLink();
  const reader = new ReaderBt(link);
  const events: [string, unknown][] = [];
  reader
    .on('cardInserted', (n) => events.push(['inserted', n]))
    .on('cardRead', (r) => events.push(['read', r.cardNumber]))
    .on('cardRemoved', (n) => events.push(['removed', n]))
    .on('error', (e) => events.push(['error', e.message]));
  await reader.start();
  const state = (card: number, inserted: boolean) =>
    link.notify(READER_BT_UUID.cardState, cardState(card, inserted));
  const data = (bytes: Uint8Array) => link.notify(READER_BT_UUID.cardData, bytes);
  const flush = () => new Promise((r) => setImmediate(r));
  return { link, events, state, data, flush };
};

describe('ReaderBt client', () => {
  test('card in: request, segmented reply, cardRead, then OK feedback', async () => {
    const { link, events, state, data, flush } = await setup();
    state(8123456, true);
    await flush();
    assert.deepEqual(link.writes, [
      { characteristic: READER_BT_UUID.cardData, bytes: REQUEST_SIAC },
    ]);
    for (const n of notifications()) data(n);
    await flush();
    assert.deepEqual(events, [
      ['inserted', 8123456],
      ['read', 8123456],
    ]);
    assert.deepEqual(link.writes[1], {
      characteristic: READER_BT_UUID.cardData,
      bytes: FEEDBACK_OK,
    });
  });

  test('card out before the reply: the late reply is ignored and gets no feedback', async () => {
    const { link, events, state, data, flush } = await setup();
    state(8123456, true);
    state(8123456, false);
    for (const n of notifications()) data(n);
    await flush();
    assert.deepEqual(events, [
      ['inserted', 8123456],
      ['removed', 8123456],
    ]);
    assert.deepEqual(
      link.writes.map((w) => w.bytes),
      [REQUEST_SIAC]
    );
  });

  test('swap: the old card’s reply is not used for the new card', async () => {
    const { link, events, state, data, flush } = await setup();
    state(1111111, true);
    state(1111111, false);
    state(2222222, true);
    data(readout(1111111));
    data(readout(2222222));
    await flush();
    assert.deepEqual(events, [
      ['inserted', 1111111],
      ['removed', 1111111],
      ['inserted', 2222222],
      ['read', 2222222],
    ]);
    assert.deepEqual(
      link.writes.map((w) => w.bytes),
      [REQUEST, REQUEST, FEEDBACK_OK]
    );
  });

  test('one read per insertion: a repeated card in is ignored until card out', async () => {
    const { link, events, state, data, flush } = await setup();
    state(1111111, true);
    data(readout(1111111));
    state(1111111, true);
    state(1111111, false);
    state(1111111, true);
    await flush();
    assert.deepEqual(
      events.map(([e]) => e),
      ['inserted', 'read', 'removed', 'inserted']
    );
    assert.deepEqual(
      link.writes.map((w) => w.bytes),
      [REQUEST, FEEDBACK_OK, REQUEST]
    );
  });

  test('a dropped connection mid-read loses the half message and the pending read', async () => {
    const { events, state, data, link, flush } = await setup();
    state(8123456, true);
    const [first, second] = notifications();
    data(first!);
    data(second!);
    link.dropConnection();
    // After reconnecting, the rest of the old message arrives without its start.
    for (const n of notifications().slice(2)) data(n);
    // A whole reply for the card read before the drop is not used either.
    data(readout(8123456));
    await flush();
    assert.deepEqual(events, [
      ['inserted', 8123456],
      ['error', 'Reader BT: segment flag 0 without a first segment'],
      ['error', 'Reader BT: segment flag 2 without a first segment'],
    ]);
  });

  test('a failed request write is reported and the card can be read on its next insertion', async () => {
    const { link, events, state, flush } = await setup();
    link.failWrites = true;
    state(1111111, true);
    await flush();
    link.failWrites = false;
    state(1111111, false);
    state(1111111, true);
    await flush();
    assert.deepEqual(
      events.map(([e]) => e),
      ['inserted', 'error', 'removed', 'inserted']
    );
    assert.deepEqual(
      link.writes.map((w) => w.bytes),
      [REQUEST]
    );
  });
});
