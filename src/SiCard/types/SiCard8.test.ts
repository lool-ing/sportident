// Test data from allestuetsmerweh/sportident.js (MIT):
// packages/sportident/src/SiCard/types/siCard8Examples.ts, getCardWith16Punches.
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../../constants.ts';
import { BaseSiCard } from '../BaseSiCard.ts';
import { SiCard8 } from './SiCard8.ts';
import { SiCard9 } from './SiCard9.ts';
import { SiCard11 } from './SiCard11.ts';
import { withoutWeekday } from './punchesWithoutWeekday.ts';

/** PTD bit 0 marks PM (documented, SPORTident doc); where this synthetic data
 * (upstream sportident.js fixture) sets it, times are +12 h. */
const PM = 43_200;

const hex = (s: string): number[] =>
  s
    .trim()
    .split(/\s+/)
    .map((b) => parseInt(b, 16));
const page0 = [
  ...hex(`
  77 2A 42 99 EA EA EA EA 37 02 22 1F 07 03 22 11
  EE EE EE EE 0F 7F 10 09 0F 23 CA CE 06 0F 61 53
  61 3B 62 3B`),
  ...Array(128 - 36).fill(0xee),
];
const page1 = [
  ...hex(`
  20 20 20 20 20 20 20 20 1F 1F 1F 1F 20 20 20 20
  21 21 21 21 22 22 22 22 23 23 23 23 24 24 24 24
  25 25 25 25 26 26 26 26 27 27 27 27 28 28 28 28
  29 29 29 29 2A 2A 2A 2A 2B 2B 2B 2B 2C 2C 2C 2C
  2D 2D 2D 2D 2E 2E 2E 2E`),
  ...Array(128 - 72).fill(0xee),
];
const expectedPunches = [
  [31, 7967],
  [32, 8224],
  [33, 8481],
  [34, 8738],
  [35, 8995],
  [36, 9252],
  [37, 9509],
  [38, 9766],
  [39, 10023],
  [40, 10280],
  [41, 10537],
  [42, 10794],
  [43, 11051],
  [44, 11308],
  [45, 11565],
  [46, 11822],
].map(([code, time]) => ({ code: code!, time: time! + (code! % 2) * PM })); // PTD byte == code here

describe('SiCard8', () => {
  test('decodes the upstream 16-punch example', () => {
    const card = new SiCard8(0);
    card.decodeFromStorage([...page0, ...page1]);
    assert.equal(card.raceResult.cardNumber, 2345678);
    assert.equal(card.punchCount, 16);
    assert.equal(card.raceResult.startTime, 8721 + PM);
    assert.equal(card.raceResult.checkTime, 8735 + PM);
    assert.deepEqual(withoutWeekday(card.raceResult.punches), expectedPunches);
  });

  test('reads pages 0 and 1 over the wire', async () => {
    const card = new SiCard8(2345678);
    const asked: number[] = [];
    card.mainStation = {
      sendMessage: async (msg) => {
        const page = (msg as { parameters: number[] }).parameters[0]!;
        asked.push(page);
        return [[proto.cmd.GET_SI8, 3 + 128, 0x00, 0x0a, page, ...(page === 0 ? page0 : page1)]];
      },
    };
    await card.read();
    assert.deepEqual(asked, [0, 1]);
    assert.deepEqual(withoutWeekday(card.raceResult.punches), expectedPunches);
  });
});

describe('SI8_DET dispatch by number', () => {
  const detect = (n: number) =>
    BaseSiCard.detectFromMessage({
      command: proto.cmd.SI8_DET,
      parameters: [0x00, 0x0a, 0x0f, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff],
    });
  test('SI8, SI9, SI11', () => {
    assert.ok(detect(2345678) instanceof SiCard8);
    assert.ok(detect(2003500) instanceof SiCard8); // own registry: no SI6* clash
    assert.ok(detect(1428838) instanceof SiCard9);
    assert.ok(detect(9123456) instanceof SiCard11);
  });
});
