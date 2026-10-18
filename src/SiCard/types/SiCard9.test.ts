// Authored for lool. Not ported from upstream.
// Fixtures from tests/fixtures/upstream/.
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SiCard9 } from './SiCard9.ts';
import { fixture as si9 } from '../../../tests/fixtures/upstream/si9-typical.ts';
import { withoutWeekday } from './punchesWithoutWeekday.ts';

function decodeSi9(storage: (number | undefined)[]): { [k: string]: unknown } {
  const card = new SiCard9(0);
  card.decodeFromStorage(storage);
  return {
    uid: card.uid,
    cardSeries: card.cardSeries,
    cardNumber: card.raceResult.cardNumber,
    startTime: card.raceResult.startTime ?? null,
    finishTime: card.raceResult.finishTime ?? null,
    checkTime: card.raceResult.checkTime ?? null,
    punchCount: card.punchCount,
    punches: withoutWeekday(card.raceResult.punches),
    cardHolder: card.raceResult.cardHolder,
  };
}

describe('SiCard9 decoder — upstream fixture', () => {
  test('SI9-typical fixture decodes byte-for-byte to expected cardData', () => {
    const decoded = decodeSi9(si9.storageData);
    assert.deepStrictEqual(decoded, si9.cardData);
  });
});
