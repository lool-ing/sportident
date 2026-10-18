// Authored for lool. Not ported from upstream.
// A 12-hour time runs 0..43199. A record with 43200 or more holds no valid
// time: it must not become 12:00:00 / 24:00:00, and an invalid punch time
// must not end the punch list (the punches after it would be lost). An empty
// slot (0xEEEE) still ends it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SiCard10 } from './SiCard10.ts';
import { cropPunches as cropModern } from './ModernSiCard.ts';
import { cropPunches as cropSi6 } from './SiCard6.ts';
import { SiCard5 } from './SiCard5.ts';
import { SiCard6 } from './SiCard6.ts';
import { fixture as si10 } from '../../../tests/fixtures/upstream/si10-typical.ts';
import { fixture as si5 } from '../../../tests/fixtures/upstream/si5-16-punches.ts';

type Card = SiCard10 | SiCard5 | SiCard6;
type Punch = { code: number; time: number | null };
const decode = (card: Card, mem: number[]): Card => {
  card.decodeFromStorage(mem);
  return card;
};
const punches = (card: Card): Punch[] => card.raceResult.punches as Punch[];
/** A modern PTD record: [ptd, cn, th, tl] with the pm bit. */
const setTime = (mem: number[], offset: number, time: number, pm: number): void => {
  mem[offset] = (mem[offset]! & 0xfe) | pm;
  mem[offset + 2] = time >> 8;
  mem[offset + 3] = time & 0xff;
};

describe('12-hour time cutoff', () => {
  test('modern card: 43200 and more give no time, and the punches after them are kept', () => {
    const mem = (si10.storageData as number[]).slice();
    const times: [number, number][] = [
      [43199, 0],
      [43200, 0],
      [43201, 0],
      [43200, 1],
      [43199, 1],
    ];
    times.forEach(([t, pm], i) => setTime(mem, 0x200 + 4 * i, t, pm));
    setTime(mem, 0x10, 43200, 1); // finish
    const card = decode(new SiCard10(0), mem);
    const p = punches(card);
    const before = punches(decode(new SiCard10(0), (si10.storageData as number[]).slice()));
    assert.equal(p.length, before.length, 'no punch lost after an invalid time');
    assert.deepEqual(
      p.map((x) => x.code),
      before.map((x) => x.code)
    );
    assert.deepEqual(
      p.slice(0, 5).map((x) => x.time),
      [43199, null, null, null, 43199 + 43200]
    );
    assert.deepEqual(p.slice(5), before.slice(5), 'the rest unchanged');
    assert.equal(
      card.raceResult.finishTime ?? null,
      null,
      'finish 43200 pm is no time, not 24:00:00'
    );
  });

  test('modern card: an empty slot (0xEEEE) still ends the list', () => {
    const mem = (si10.storageData as number[]).slice();
    mem.splice(0x200 + 4 * 3, 4, 0xee, 0xee, 0xee, 0xee);
    assert.equal(punches(decode(new SiCard10(0), mem)).length, 3);
  });

  test('SI6: 43201 gives no time and the later punches stay', () => {
    const mem = new Array<number>(0x400).fill(0xee);
    mem[0x12] = 4; // punch count
    [
      [43199, 0],
      [43201, 0],
      [100, 1],
      [200, 0],
    ].forEach(([t, pm], i) => {
      mem.splice(0x300 + 4 * i, 4, 0x00, 31 + i, 0, 0);
      setTime(mem, 0x300 + 4 * i, t!, pm!);
    });
    const codeTime = punches(decode(new SiCard6(0), mem)).map(({ code, time }) => ({ code, time }));
    assert.deepEqual(codeTime, [
      { code: 31, time: 43199 },
      { code: 32, time: null },
      { code: 33, time: 100 + 43200 },
      { code: 34, time: 200 },
    ]);
  });

  test('SI5: 43200 gives no time (null), 43199 stays, no punch lost', () => {
    const mem = (si5.storageData as number[]).slice();
    const before = punches(decode(new SiCard5(0), mem.slice()));
    // SI5 punch 1 at 0x21: [code, th, tl]; punch 2 at 0x24.
    mem.splice(0x22, 2, 43200 >> 8, 43200 & 0xff);
    mem.splice(0x25, 2, 43199 >> 8, 43199 & 0xff);
    const p = punches(decode(new SiCard5(0), mem));
    assert.equal(p.length, before.length);
    assert.deepEqual(
      p.slice(0, 2).map((x) => x.time),
      [null, 43199]
    );
  });

  test('cropPunches keeps the other fields of a punch (eg its day of week)', () => {
    const slots = [
      { code: 31, time: 100, weekdayRaw: 2 },
      { code: 32, time: undefined, weekdayRaw: 3 }, // out of range
      { code: undefined, time: null }, // empty: ends the list
    ];
    const kept = [
      { code: 31, time: 100, weekdayRaw: 2 },
      { code: 32, time: null, weekdayRaw: 3 },
    ];
    assert.deepEqual(cropModern(slots as never), kept);
    assert.deepEqual(cropSi6(slots as never), kept);
  });
});
