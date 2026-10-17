// Authored for lool. Not ported from upstream.
// Assertions hand-written for node:test. Upstream uses jest +
// modernSiCardExamples/siCard5Examples helpers; the fixtures themselves are in
// tests/fixtures/upstream/*.ts with the upstream MIT attribution.
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { SiCard5 } from './SiCard5.ts';
import { fixture as si5_16 } from '../../../tests/fixtures/upstream/si5-16-punches.ts';
import { fixture as si5_full } from '../../../tests/fixtures/upstream/si5-full.ts';

// Helper: decode a fixture's storageData blob via SiCard5 and return the
// {raceResult + class fields} shape that fixture.cardData expresses.
function decodeSi5(storage: (number | undefined)[]): { [k: string]: unknown } {
  const card = new SiCard5(0);
  card._decodeFromStorage(storage);
  return {
    cardNumber: card.raceResult.cardNumber,
    startTime: card.raceResult.startTime ?? null,
    finishTime: card.raceResult.finishTime ?? null,
    checkTime: card.raceResult.checkTime ?? null,
    punchCount: card.punchCount,
    punches: card.raceResult.punches,
    cardHolder: card.raceResult.cardHolder,
    softwareVersion: card.softwareVersion,
  };
}

describe('SiCard5 decoder — upstream fixtures', () => {
  test('SI5-16-punches fixture decodes byte-for-byte to expected cardData', () => {
    const decoded = decodeSi5(si5_16.storageData);
    assert.deepStrictEqual(decoded, si5_16.cardData);
  });

  test('SI5-full fixture (36 punches incl. slots 30-35 codes-only)', () => {
    const decoded = decodeSi5(si5_full.storageData);
    assert.deepStrictEqual(decoded, si5_full.cardData);
  });
});
