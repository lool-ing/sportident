// Authored for lool. Not ported from upstream.
//
// Subsecond of start/finish records: PTD bit 7 set -> CN is TSS, 1/256 s
// (SPORTident card data structure doc, provided on request: "subsecond value
// only for start and finish", record TD-TSS-TH-TL; PC Programmer's Guide 5,
// TSS = 1/256 s). Check and ordinary punch records never carry a fraction.

// Evidence tags used in comments below: documented (SPORTident doc) = the card
// data structure doc, provided on request; MeOS behaviour = MeOS
// SportIdent.cpp; bench capture <fixture>; assumption, unverified.
//
// Erased start/finish (no fraction): our own design, assumption, unverified on hardware.
// bench capture siac-bench-001 (touch-free finish, CN 117) is pinned in
// tests/fixtures/bench/siac-bench-001.expected.json and in the edge cardReadPayload test.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SiCard6 } from './SiCard6.ts';
import { SiCard8 } from './SiCard8.ts';
import { SiCard9 } from './SiCard9.ts';
import { SiCard10 } from './SiCard10.ts';
import { NdjsonEmitter } from '../../output/ndjson.ts';

type Layout = { size: number; start: number; finish: number; check: number };
const MODERN: Layout = { size: 0x400, start: 0x0c, finish: 0x10, check: 0x08 };
const CARDS = [
  ['SI10', SiCard10, MODERN],
  ['SI9', SiCard9, { ...MODERN, size: 0x100 }],
  ['SI8', SiCard8, { ...MODERN, size: 0x100 }],
  ['SI6', SiCard6, { size: 0x400, start: 0x18, finish: 0x14, check: 0x1c }],
] as const;

/** Erased image with one record at `offset`: [ptd, cn, 0x0e, 0x10] = 01:00:00 PM. */
function image(size: number, records: [number, number, number][]): number[] {
  const mem = new Array<number>(size).fill(0xee);
  for (const [offset, ptd, cn] of records) mem.splice(offset, 4, ptd, cn, 0x0e, 0x10);
  return mem;
}

function decode(Card: (typeof CARDS)[number][1], bytes: number[]) {
  const card = new Card(0);
  card.decodeFromStorage(bytes);
  return card.raceResult;
}

for (const [name, Card, l] of CARDS) {
  describe(`${name} start/finish subsecond`, () => {
    test('bit 7 set: CN is TSS in 1/256 s [documented (SPORTident doc)]', () => {
      const r = decode(
        Card,
        image(l.size, [
          [l.start, 0x81, 128],
          [l.finish, 0x81, 255],
        ])
      );
      assert.equal(r.startSubsec256, 128);
      assert.equal(r.finishSubsec256, 255);
    });

    test('fraction 0 is present, no bit 7 is absent [documented (SPORTident doc)]', () => {
      const zero = decode(
        Card,
        image(l.size, [
          [l.start, 0x81, 0],
          [l.finish, 0x01, 20],
        ])
      );
      assert.equal(zero.startSubsec256, 0);
      assert.equal(zero.finishSubsec256, undefined);
      assert.equal(zero.finishCode, 20);
    });

    test('check record with bit 7: CN is no fraction [documented (SPORTident doc)]', () => {
      const r = decode(Card, image(l.size, [[l.check, 0x81, 77]]));
      assert.ok(!('checkSubsec256' in r));
      assert.equal(r.startSubsec256, undefined);
      assert.equal(r.finishSubsec256, undefined);
    });

    test('erased start/finish: no fraction', () => {
      const r = decode(Card, image(l.size, []));
      assert.equal(r.startSubsec256, undefined);
      assert.equal(r.finishSubsec256, undefined);
    });
  });
}

describe('subsecond in the NDJSON card_read', () => {
  test('start/finish clocks carry subsec_256; check and punches never', () => {
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({ device_path: '/dev/x', out: (l) => lines.push(l) });
    const mem = image(0x400, [
      [0x0c, 0x81, 64],
      [0x10, 0x81, 0],
      [0x08, 0x81, 99],
    ]);
    mem[0x16] = 1;
    mem.splice(0x200, 4, 0x81, 31, 0x0e, 0x10);
    const card = new SiCard10(0);
    card.decodeFromStorage(mem);
    emitter.card_read({ card });
    const ev = JSON.parse(lines[0]!);
    assert.equal(ev.start.subsec_256, 64);
    assert.equal(ev.finish.subsec_256, 0);
    assert.equal('subsec_256' in ev.check, false);
    assert.equal('subsec_256' in ev.punches[0], false);
  });

  test('no bit 7: no subsec_256 key (backward compatible)', () => {
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({ device_path: '/dev/x', out: (l) => lines.push(l) });
    const card = new SiCard10(0);
    card.decodeFromStorage(
      image(0x400, [
        [0x0c, 0x01, 3],
        [0x10, 0x01, 4],
      ])
    );
    emitter.card_read({ card });
    const ev = JSON.parse(lines[0]!);
    assert.equal('subsec_256' in ev.start, false);
    assert.equal('subsec_256' in ev.finish, false);
  });
});

describe('SI6 start/finish station code with PTD bit 7', () => {
  test('CN is the fraction, so there is no code [documented (SPORTident doc)]', () => {
    const r = decode(
      SiCard6,
      image(0x400, [
        [0x18, 0x81, 117],
        [0x14, 0xc1, 5],
        [0x1c, 0x81, 9],
      ])
    );
    assert.equal(r.startSubsec256, 117);
    assert.equal(r.startCode, undefined);
    assert.equal(r.finishSubsec256, 5);
    assert.equal(r.finishCode, undefined);
    // Check keeps its CN as the code: no subsecond on check records.
    assert.equal(r.checkCode, 9);
  });

  test('without bit 7 the code is unchanged (CN + PTD bit 6)', () => {
    const r = decode(
      SiCard6,
      image(0x400, [
        [0x18, 0x41, 3],
        [0x14, 0x01, 20],
      ])
    );
    assert.equal(r.startCode, 259);
    assert.equal(r.finishCode, 20);
  });
});
