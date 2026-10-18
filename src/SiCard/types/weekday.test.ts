// Authored for lool. Not ported from upstream.
//
// Day of week of a PTD record: PTD bits 3-1 (3-bit value 0-7). SPORTident.Communication 2.59.0
// on a synthetic image of our fixture siac-bench-001 (first 8 punches set to 0..7, rest unchanged,
// 2026-10-18): 0 = Sunday ... 6 = Saturday, 7 = not set or invalid. The card stores no date, so
// this is never a calendar date. SI5 has no PTD.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { dayOfWeekFromRaw } from '../../siProtocol.ts';
import { NdjsonEmitter } from '../../output/ndjson.ts';
import { SIAC } from './SIAC.ts';
import { SiCard6 } from './SiCard6.ts';
import { SiCard5 } from './SiCard5.ts';
import { fixture as siac } from '../../../tests/fixtures/upstream/siac-typical.ts';
import { fixture as si5 } from '../../../tests/fixtures/upstream/si5-full.ts';

const PUNCH_BASE = 0x200;
const base = siac.storageData as number[];

/** Set PTD bits 3-1 of the record at `at`, leaving the other bits. */
function setDay(mem: number[], at: number, day: number): void {
  mem[at] = ((mem[at] as number) & 0xf1) | (day << 1);
}

/** The fixture image with PTD bits 3-1 of the first 8 punches set to 0..7, all other bits kept. */
function withWeekdays(): number[] {
  const mem = [...base];
  for (let i = 0; i < 8; i++) {
    const at = PUNCH_BASE + 4 * i;
    setDay(mem, at, i);
  }
  return mem;
}

function decode(mem: number[]) {
  const card = new SIAC(0);
  card.decodeFromStorage(mem);
  return card.raceResult;
}

describe('day of week (PTD bits 3-1)', () => {
  test('helper: 0 Sunday .. 6 Saturday, 7 not set', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(dayOfWeekFromRaw), [0, 1, 2, 3, 4, 5, 6, null]);
  });

  test('modern punches: raw 0..7, every other field unchanged', () => {
    const before = decode(base);
    const after = decode(withWeekdays());
    const punches = after.punches ?? [];
    assert.deepEqual(
      punches.slice(0, 8).map((p) => p.weekdayRaw),
      [0, 1, 2, 3, 4, 5, 6, 7]
    );
    const strip = (r: typeof before) => ({
      ...r,
      punches: (r.punches ?? []).map(({ code, time }) => ({ code, time })),
    });
    assert.deepEqual(strip(after), strip(before));
  });

  test('start/finish/check records carry their own raw value', () => {
    const mem = [...base];
    setDay(mem, 0x08, 2); // check
    setDay(mem, 0x0c, 5); // start
    mem.splice(0x10, 4, 0x01 | (7 << 1), 5, 0x0e, 0x10); // finish, was erased
    const r = decode(mem);
    assert.equal(r.checkWeekdayRaw, 2);
    assert.equal(r.startWeekdayRaw, 5);
    assert.equal(r.finishWeekdayRaw, 7);
  });

  test('SI6 clear record', () => {
    const mem = new Array<number>(0x400).fill(0xee);
    mem.splice(0x20, 4, 0x01 | (3 << 1), 0, 0x0e, 0x10);
    const card = new SiCard6(0);
    card.decodeFromStorage(mem);
    assert.equal(card.raceResult.clearWeekdayRaw, 3);
  });

  test('absent record has no weekday', () => {
    assert.equal(decode(base).finishWeekdayRaw, undefined);
  });

  test('SI5 has none', () => {
    const card = new SiCard5(0);
    card.decodeFromStorage(si5.storageData as number[]);
    assert.ok((card.raceResult.punches ?? []).every((p) => p.weekdayRaw === undefined));
    assert.equal(card.raceResult.startWeekdayRaw, undefined);
  });

  test('NDJSON: weekday 0-6 or null, weekday_raw 0-7', () => {
    const card = new SIAC(0);
    card.decodeFromStorage(withWeekdays());
    const lines: string[] = [];
    new NdjsonEmitter({ device_path: 'x', out: (l) => lines.push(l) }).card_read({ card });
    const ev = JSON.parse(lines[0] as string);
    const p = ev.punches.slice(0, 8);
    assert.deepEqual(
      p.map((x: { weekday: number | null }) => x.weekday),
      [0, 1, 2, 3, 4, 5, 6, null]
    );
    assert.deepEqual(
      p.map((x: { weekday_raw: number }) => x.weekday_raw),
      [0, 1, 2, 3, 4, 5, 6, 7]
    );
    assert.equal(ev.start.weekday, 3);
    assert.equal(ev.start.weekday_raw, 3);
  });

  test('NDJSON: the day of week does not depend on a valid time', () => {
    const card = new SIAC(0);
    card.decodeFromStorage(withWeekdays());
    // A punch whose time is not valid (eg out of range) still has its day.
    (card.raceResult.punches as { time: number | null }[])[3]!.time = null;
    const lines: string[] = [];
    new NdjsonEmitter({ device_path: 'x', out: (l) => lines.push(l) }).card_read({ card });
    const p = JSON.parse(lines[0] as string).punches[3];
    assert.equal(p.weekday, 3);
    assert.equal(p.weekday_raw, 3);
  });

  test('NDJSON: SI5 punch has weekday null and no weekday_raw', () => {
    const card = new SiCard5(0);
    card.decodeFromStorage(si5.storageData as number[]);
    const lines: string[] = [];
    new NdjsonEmitter({ device_path: 'x', out: (l) => lines.push(l) }).card_read({ card });
    const p = JSON.parse(lines[0] as string).punches[0];
    assert.equal(p.weekday, null);
    assert.equal('weekday_raw' in p, false);
  });
});
