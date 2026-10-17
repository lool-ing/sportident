// Authored for lool. Not ported from upstream.
//
// The card's punch count bounds its punches: slots past it are left over from
// an earlier use of the card (or never written) and may still look valid.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SiCard5, getPunchOffset as si5PunchOffset } from './SiCard5.ts';
import { SiCard6, getPunchOffset as si6PunchOffset } from './SiCard6.ts';
import { SiCard8, getPunchOffset as si8PunchOffset } from './SiCard8.ts';
import { SiCard9, getPunchOffset as si9PunchOffset } from './SiCard9.ts';
import { SiCard10 } from './SiCard10.ts';
import { SIAC } from './SIAC.ts';
import { getPunchOffset as modernPunchOffset } from './ModernSiCard.ts';

interface Decodable {
  _decodeFromStorage(bytes: (number | undefined)[]): void;
  raceResult: { punches?: { code: number; time: number | null }[] };
}

describe('punches stop at the punch count', () => {
  // [name, card, punch-count offset, stored value for a count of 2, punch offset, record bytes]
  for (const [name, card, countOffset, countByte, offset, record] of [
    ['SiCard5', new SiCard5(0), 0x17, 3, si5PunchOffset, (i: number) => [31 + i, 0x0e, 0x10]],
    ['SiCard6', new SiCard6(0), 0x12, 2, si6PunchOffset, (i: number) => [0, 31 + i, 0x0e, 0x10]],
    ['SiCard8', new SiCard8(0), 0x16, 2, si8PunchOffset, (i: number) => [0, 31 + i, 0x0e, 0x10]],
    ['SiCard9', new SiCard9(0), 0x16, 2, si9PunchOffset, (i: number) => [0, 31 + i, 0x0e, 0x10]],
    [
      'SiCard10',
      new SiCard10(0),
      0x16,
      2,
      modernPunchOffset,
      (i: number) => [0, 31 + i, 0x0e, 0x10],
    ],
    ['SIAC', new SIAC(0), 0x16, 2, modernPunchOffset, (i: number) => [0, 31 + i, 0x0e, 0x10]],
  ] as const) {
    test(`${name}: punch count 2 with 5 valid-looking slots gives 2 punches`, () => {
      const bytes = Array<number>(0x400).fill(name === 'SiCard5' ? 0x00 : 0xee);
      bytes[countOffset] = countByte;
      for (let i = 0; i < 5; i++) {
        const r = record(i);
        bytes.splice(offset(i), r.length, ...r);
      }
      const decodable: Decodable = card;
      decodable._decodeFromStorage(bytes);
      assert.deepStrictEqual(
        decodable.raceResult.punches?.map((p) => p.code),
        [31, 32]
      );
    });
  }
});
