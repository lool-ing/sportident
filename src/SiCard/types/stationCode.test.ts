// Authored for lool. Not ported from upstream.
//
// Station codes (CN) of the start, finish and check units. In the record
// [ptd, cn, time_hi, time_lo] the CN is the byte after the PTD that SiTime
// uses (0x0c/0x10/0x08 on SI8 and newer, 0x18/0x14/0x1c on SI6). SI5 has no CN.

// Evidence tags used in comments below: documented (SPORTident doc) = the card
// data structure doc, provided on request; MeOS behaviour = MeOS
// SportIdent.cpp; bench capture <fixture>; assumption, unverified.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SiCard5 } from './SiCard5.ts';
import { SiCard10 } from './SiCard10.ts';
import { SiCard6 } from './SiCard6.ts';
import { fixture as si10 } from '../../../tests/fixtures/upstream/si10-typical.ts';
import { fixture as si5 } from '../../../tests/fixtures/upstream/si5-full.ts';
import { toHalfDayClock } from '../../output/ndjson.ts';

interface Decodable {
  decodeFromStorage(bytes: (number | undefined)[]): void;
  raceResult: {
    startTime?: number | null;
    finishTime?: number | null;
    checkTime?: number | null;
    startCode?: number;
    finishCode?: number;
    checkCode?: number;
  };
}

/** Put a PTD/CN/time record at `offset`: PTD 0x01 (PM bit), time 10:00:00 PM. */
function setRecord(bytes: number[], offset: number, cn: number): void {
  bytes.splice(offset, 4, 0x01, cn, 0x0e, 0x10);
}

describe('station codes of start, finish and check', () => {
  test('SI10: start 3, finish 10, check 22 are decoded next to the times', () => {
    // Record layout TD-CN-TH-TL at 0x0c / 0x10 / 0x08: documented (SPORTident doc).
    const bytes = si10.storageData.map((b) => b ?? 0xee);
    setRecord(bytes, 0x0c, 3);
    setRecord(bytes, 0x10, 10);
    setRecord(bytes, 0x08, 22);
    const card: Decodable = new SiCard10(0);
    card.decodeFromStorage(bytes);
    assert.equal(card.raceResult.startCode, 3);
    assert.equal(card.raceResult.finishCode, 10);
    assert.equal(card.raceResult.checkCode, 22);
  });

  test('SI6: the CN sits at 0x19 / 0x15 / 0x1d', () => {
    // Page 1 order pointer, finish, start, check: documented (SPORTident doc).
    const bytes = new Array<number>(0x400).fill(0xee);
    setRecord(bytes, 0x18, 13);
    setRecord(bytes, 0x14, 20);
    setRecord(bytes, 0x1c, 12);
    const card: Decodable = new SiCard6(0);
    card.decodeFromStorage(bytes);
    assert.deepEqual(
      [card.raceResult.startCode, card.raceResult.finishCode, card.raceResult.checkCode],
      [13, 20, 12]
    );
  });

  test('codes above 255 use the PTD bits: 259, 266 and 278 on SI10 and 259 on SI6', () => {
    // PTD 0x41 (bit 0 PM, bit 6 = 1 -> +256), CN 3 / 10 / 22.
    // PTD bit 6 as code bit 8: documented (SPORTident doc, "bit 7...6 control station code number high").
    const bytes = si10.storageData.map((b) => b ?? 0xee);
    bytes.splice(0x0c, 4, 0x41, 3, 0x0e, 0x10);
    bytes.splice(0x10, 4, 0x41, 10, 0x0e, 0x10);
    bytes.splice(0x08, 4, 0x41, 22, 0x0e, 0x10);
    const card: Decodable = new SiCard10(0);
    card.decodeFromStorage(bytes);
    assert.deepEqual(
      [card.raceResult.startCode, card.raceResult.finishCode, card.raceResult.checkCode],
      [259, 266, 278]
    );
    const six = new Array<number>(0x400).fill(0xee);
    six.splice(0x18, 4, 0x41, 3, 0x0e, 0x10);
    const card6: Decodable = new SiCard6(0);
    card6.decodeFromStorage(six);
    assert.equal(card6.raceResult.startCode, 259);
  });

  test('PTD bit 7 is not a code bit: a bit-7 SI10 finish has no code, whatever 0xa9 holds', () => {
    // Bit 7 marks a subsecond (CN = TSS): documented (SPORTident doc). SI10/SI11
    // do not use 0xa5 / 0xa9 (SPORTident (Thomas, 2026-10-09)); SIAC: block1Codes.test.ts.
    const bytes: (number | undefined)[] = si10.storageData.map((b) => b ?? 0xee);
    bytes.splice(0x10, 4, 0xc1, 3, 0x0e, 0x10);
    bytes[0xa9] = 20;
    const card: Decodable = new SiCard10(0);
    card.decodeFromStorage(bytes);
    assert.equal(card.raceResult.finishCode, undefined);
  });

  test('a bit-7 check record keeps its own code: CN + 256 × bit 6, not 0xa1', () => {
    // MeOS reads 0xa1 for a bit-7 check; SPORTident takes CN (SPORTident (Thomas,
    // 2026-10-09); SPORTident.Communication 2.59.0 on card images, 2026-10-08).
    for (const [ptd, code] of [
      [0x81, 77],
      [0xc1, 333],
    ] as const) {
      const bytes = new Array<number>(0x100).fill(0xee).map((_, i) => si10.storageData[i] ?? 0xee);
      bytes.splice(0x08, 4, ptd, 77, 0x0e, 0x10);
      bytes[0xa1] = 99;
      const card: Decodable = new SiCard10(0);
      card.decodeFromStorage(bytes);
      assert.equal(card.raceResult.checkCode, code);
    }
  });

  test('a missing time carries no code', () => {
    // Own design (an erased/cleared record has no station): assumption, unverified on hardware.
    const bytes = si10.storageData.map((b) => b ?? 0xee);
    bytes.splice(0x0c, 4, 0x00, 0x03, 0xee, 0xee); // start empty, CN left behind
    const card: Decodable = new SiCard10(0);
    card.decodeFromStorage(bytes);
    assert.equal(card.raceResult.startCode, undefined);
  });

  test('SI5 has none', () => {
    const card: Decodable = new SiCard5(0);
    card.decodeFromStorage(si5.storageData.map((b) => b ?? 0xee));
    assert.equal(card.raceResult.startCode, undefined);
    assert.equal(card.raceResult.finishCode, undefined);
    assert.equal(card.raceResult.checkCode, undefined);
  });

  test('toHalfDayClock adds the code only when there is one', () => {
    assert.deepEqual(toHalfDayClock(100, 10), {
      seconds_in_half_day: 100,
      half_day: 0,
      weekday: null,
      code: 10,
    });
    assert.deepEqual(toHalfDayClock(100), { seconds_in_half_day: 100, half_day: 0, weekday: null });
    assert.equal(toHalfDayClock(null, 10), null);
  });
});
