// Test data from allestuetsmerweh/sportident.js (MIT):
// packages/sportident/src/SiCard/types/siCard6Examples.ts, getCardWith16Punches.
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../../constants.ts';
import { BaseSiCard } from '../BaseSiCard.ts';
import { SiCard6 } from './SiCard6.ts';
import { withoutWeekday } from './punchesWithoutWeekday.ts';

const hex = (s: string): number[] =>
  s
    .trim()
    .split(/\s+/)
    .map((b) => parseInt(b, 16));
const block0 = hex(`
  01 01 01 01 ED ED ED ED 55 AA 00 07 A1 3D 6E 8B
  00 2E 10 11 00 0A 28 0A 03 0A 95 99 03 0A 95 8B
  03 0A 95 76 FF FF FF FF 00 00 00 01 20 20 20 20
  62 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 61 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 6B 20 20 20 65 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20`);
const block6 = [
  ...hex(`
  20 01 00 01 20 02 00 02 20 03 00 03 20 04 00 04
  20 05 01 01 20 06 01 02 20 07 01 03 20 08 01 04
  20 09 02 01 20 0A 02 02 20 0B 02 03 20 0C 02 04
  20 0D 03 01 20 0E 03 02 20 0F 03 03 20 10 03 04`),
  ...Array(64).fill(0xee),
];

const expectedPunches = Array.from({ length: 16 }, (_, i) => ({
  code: i + 1,
  time: Math.floor(i / 4) * (256 - 4) + i + 1,
}));

/** PTD bit 0 marks PM (documented, SPORTident doc); where this synthetic data
 * (upstream sportident.js fixture) sets it, times are +12 h. */
const PM = 43_200;

describe('SiCard6', () => {
  test('decodes the upstream 16-punch example', () => {
    const card = new SiCard6(0);
    card.decodeFromStorage([...block0, ...Array(128 * 5).fill(undefined), ...block6]);
    assert.equal(card.raceResult.cardNumber, 500029);
    assert.equal(card.punchCount, 16);
    assert.equal(card.raceResult.startTime, 38297 + PM);
    assert.equal(card.raceResult.finishTime, 10250);
    assert.equal(card.raceResult.checkTime, 38283 + PM);
    assert.equal(card.raceResult.clearTime, 38262 + PM);
    assert.deepEqual(withoutWeekday(card.raceResult.punches), expectedPunches);
  });

  test('reads blocks 0 and 6 over the wire (data after addr + block bytes)', async () => {
    const card = new SiCard6(500029);
    const asked: number[] = [];
    card.mainStation = {
      sendMessage: async (msg) => {
        const block = (msg as { parameters: number[] }).parameters[0]!;
        asked.push(block);
        const data = block === 0 ? block0 : block6;
        return [[proto.cmd.GET_SI6, 3 + 128, 0x00, 0x0a, block, ...data]];
      },
    };
    await card.read();
    assert.deepEqual(asked, [0, 6]); // 16 punches: block 7 not needed
    assert.deepEqual(withoutWeekday(card.raceResult.punches), expectedPunches);
  });

  test('SI6_DET (0xE6) detects an SI6, other detect commands do not', () => {
    const params = [0x00, 0x0a, 0x00, 0x07, 0xca, 0x32]; // card 510514 = 0x07CA32
    const card = BaseSiCard.detectFromMessage({ command: proto.cmd.SI6_DET, parameters: params });
    assert.ok(card instanceof SiCard6);
    assert.equal(card.cardNumber, 510514);
    assert.ok(
      !(
        BaseSiCard.detectFromMessage({ command: proto.cmd.SI5_DET, parameters: params }) instanceof
        SiCard6
      )
    );
  });
});
