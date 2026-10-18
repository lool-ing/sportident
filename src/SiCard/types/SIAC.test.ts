// Authored for lool. Not ported from upstream.
// Fixtures from tests/fixtures/upstream/.
// Covers: (1) storage decode, (2) SI8_DET dispatch to SIAC, (3) cross-registry
// forward (SI8_DET with sub-SI8 cardNumber -> undefined), (4) cross-registry
// reverse (SI5_DET with SIAC-range cardNumber NEVER -> SIAC), (5) empty-card
// fixture decodes without crash.
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../../constants.ts';
import { type SiMessage } from '../../siProtocol.ts';
import { BaseSiCard } from '../BaseSiCard.ts';
// Side-effect registry population:
import { SIAC } from './SIAC.ts';
import { SiCard10 } from './SiCard10.ts';
import './SiCard9.ts';
import { SiCard5 } from './SiCard5.ts';
import { fixture as siac } from '../../../tests/fixtures/upstream/siac-typical.ts';
import { fixture as empty } from '../../../tests/fixtures/upstream/empty-card.ts';
import { withoutWeekday } from './punchesWithoutWeekday.ts';

function decodeSiac(storage: (number | undefined)[]): { [k: string]: unknown } {
  const card = new SIAC(0);
  card._decodeFromStorage(storage);
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

function makeDetMessage(
  command: number,
  seriesByte: number,
  b19: number,
  b1A: number,
  b1B: number
): SiMessage {
  return {
    command,
    parameters: [0x00, 0x00, seriesByte, b19, b1A, b1B],
  };
}

describe('SIAC decoder — upstream fixture (derived)', () => {
  test('1) SIAC-typical fixture decodes to expected cardData', () => {
    const decoded = decodeSiac(siac.storageData);
    assert.deepStrictEqual(decoded, siac.cardData);
  });

  test('2) detectFromMessage(SI8_DET, cardNumber in SIAC range) -> SIAC instance', () => {
    // 8_500_608 = 0x81B580 -> bytes b19=0x81, b1A=0xB5, b1B=0x80
    const msg = makeDetMessage(proto.cmd.SI8_DET, 0x0f, 0x81, 0xb5, 0x80);
    const card = BaseSiCard.detectFromMessage(msg);
    assert.ok(card instanceof SIAC, 'expected SIAC instance, got ' + card?.constructor.name);
    assert.strictEqual(card.cardNumber, 8_500_608);
    assert.strictEqual(card.cardSeriesByte, 0x0f);
  });

  test('3) cross-registry forward: SI8_DET with cardNumber 50000 -> undefined (NOT SiCard5)', () => {
    const msg = makeDetMessage(proto.cmd.SI8_DET, 0x01, 0x00, 0xc3, 0x50);
    const card = BaseSiCard.detectFromMessage(msg);
    assert.strictEqual(card, undefined);
  });

  test('4) cross-registry reverse: SI5_DET with SIAC-range cardNumber -> NEVER SIAC', () => {
    // cardNumber 8_500_608 falls in SIAC's SI8 range, but the detection command
    // is SI5_DET so the SI8 registry is NEVER consulted. The SI5 registry
    // covers 1000..500000; 8_500_608 is outside that, so the result is undefined.
    const msg = makeDetMessage(proto.cmd.SI5_DET, 0x00, 0x81, 0xb5, 0x80);
    const card = BaseSiCard.detectFromMessage(msg);
    assert.ok(
      !(card instanceof SIAC),
      'SI5_DET must NEVER instantiate SIAC regardless of cardNumber'
    );
    // For this specific cardNumber, no SI5 registry entry covers it, so the
    // expected outcome is undefined (the registry is empty for that range).
    assert.strictEqual(card, undefined);
  });

  test('4b) cross-registry reverse (positive): SI5_DET with SI5-range cardNumber -> SiCard5', () => {
    // 50000 falls in SiCard5's SI5 range. The detection command is SI5_DET so
    // the SI5 registry IS consulted and the result is a SiCard5 (not undefined
    // and certainly not a modern card type).
    const msg = makeDetMessage(proto.cmd.SI5_DET, 0x00, 0x00, 0xc3, 0x50);
    const card = BaseSiCard.detectFromMessage(msg);
    assert.ok(card instanceof SiCard5, 'expected SiCard5, got ' + card?.constructor.name);
  });

  test('5) empty-card fixture decodes to punches: [] without throwing', () => {
    const card = new SiCard10(0);
    assert.doesNotThrow(() => card._decodeFromStorage(empty.storageData));
    assert.deepStrictEqual(card.raceResult.punches, []);
    assert.strictEqual(card.punchCount, 0);
  });
});
