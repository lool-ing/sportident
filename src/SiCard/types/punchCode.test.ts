// Authored for lool. Not ported from upstream.
//
// Control codes above 255 on PTD punch records. A record is
// [ptd, cn, time_hi, time_lo]; CN holds code bits 0-7 and PTD bit 6 is code
// bit 8, so control code = cn + 256 * ((ptd >> 6) & 1). PTD bit 7 is not a code
// bit (MeOS SportIdent.cpp:1919). `41 2C 0E 10` is control 300 (0x2C = 44, PTD 0x40 → +256),
// punched at 01:00 PM (PTD bit 0 set → 3600 + 43 200 s).
// See NOTICE.md for cumulative attribution.

// Evidence tags used in comments below: documented (SPORTident doc) = the card
// data structure doc, provided on request; MeOS behaviour = MeOS
// SportIdent.cpp; bench capture <fixture>; assumption, unverified.
//
// PTD bit 6 = code bit 8: documented (SPORTident doc). PTD bit 7 on an ordinary
// punch: assumption, unverified (the doc defines it only for start/finish).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SiCard6, getPunchOffset as si6PunchOffset } from './SiCard6.ts';
import { SiCard8, getPunchOffset as si8PunchOffset } from './SiCard8.ts';
import { SiCard9, getPunchOffset as si9PunchOffset } from './SiCard9.ts';
import { SiCard10 } from './SiCard10.ts';
import { SiCard11 } from './SiCard11.ts';
import { SIAC } from './SIAC.ts';
import { getPunchOffset as modernPunchOffset } from './ModernSiCard.ts';
import { fixture as si10 } from '../../../tests/fixtures/upstream/si10-typical.ts';
import { withoutWeekday } from './punchesWithoutWeekday.ts';

const CODE_300_RECORD = [0x41, 0x2c, 0x0e, 0x10];
const CODE_300_PUNCH = { code: 300, time: 3600 + 43_200 };

/** `storage` with the punch record at `offset` replaced by control 300. */
function withCode300(storage: readonly (number | undefined)[], offset: number): number[] {
  const bytes = storage.map((b) => b ?? 0xee);
  bytes.splice(offset, 4, ...CODE_300_RECORD);
  return bytes;
}

interface Decodable {
  _decodeFromStorage(bytes: (number | undefined)[]): void;
  raceResult: { punches?: { code: number; time: number | null; weekdayRaw?: number }[] };
}

describe('punch control code: PTD bit 6 is code bit 8, bit 7 is not a code bit', () => {
  for (const [name, Card] of [
    ['SiCard10', SiCard10],
    ['SiCard11', SiCard11],
    ['SIAC', SIAC],
  ] as const) {
    test(`${name}: upstream SI10 fixture with control 300 as its first punch`, () => {
      const card: Decodable = new Card(0);
      card._decodeFromStorage(withCode300(si10.storageData, modernPunchOffset(0)));
      const punches = card.raceResult.punches ?? [];
      assert.deepStrictEqual(withoutWeekday(punches)[0], CODE_300_PUNCH);
      // The other 15 punches have PTD bits 6-7 clear and decode as before.
      assert.deepStrictEqual(
        withoutWeekday(punches).slice(1),
        (si10.cardData['punches'] as unknown[]).slice(1)
      );
    });
  }

  for (const [name, card, offset] of [
    ['SiCard6', new SiCard6(0), si6PunchOffset(0)],
    ['SiCard8', new SiCard8(0), si8PunchOffset(0)],
    ['SiCard9', new SiCard9(0), si9PunchOffset(0)],
  ] as const) {
    test(`${name}: a punch record with PTD 0x41 decodes as control 300`, () => {
      const decodable: Decodable = card;
      decodable._decodeFromStorage(withCode300(Array<number>(0x400).fill(0xee), offset));
      assert.deepStrictEqual(withoutWeekday(decodable.raceResult.punches), [CODE_300_PUNCH]);
    });
  }

  test('PTD bit 7 on an ordinary punch record is not a code bit', () => {
    // assumption, unverified: CN stays the code on a bit-7 control punch (MeOS applies its
    // block-1 lookup to every record it analyses, which cannot be right for control punches).
    const card: Decodable = new SiCard10(0);
    const bytes = si10.storageData.map((b) => b ?? 0xee);
    bytes.splice(modernPunchOffset(0), 4, 0x81, 0x2c, 0x0e, 0x10);
    card._decodeFromStorage(bytes);
    assert.equal(card.raceResult.punches?.[0]?.code, 44);
  });
});
