// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/siCard9Examples.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Specifically: the `getCardWith16Punches` SI9 export. cardData + storageData copied byte-for-byte.
// LooL: times whose punch record has PTD bit 0 (PM) set are +43200 vs upstream,
// because LooL decodes the PM flag and upstream does not.
// SI9 layout differs from generic ModernSiCard: punch offset 0x38 + i*4, max 50 punches across
// pages 0+1, shorter (24-byte) cardholder.
// See NOTICE.md for cumulative attribution.

import { unPrettyHex } from '../../../src/utils/bytes.ts';
import type { SiCardSample } from '../../../src/SiCard/ISiCardExamples.ts';

const noTimesPage = unPrettyHex(`
  EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
  EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
  EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
  EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
  EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
  EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
  EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
  EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
`);

export const fixture: SiCardSample & { name: string } = {
  name: 'SI9-typical (upstream getCardWith16Punches)',
  cardData: {
    uid: 0x772a4299,
    // Series byte at offset 0x18 is 0x0F in upstream's fixture — anomalous (SI9
    // would normally be 0x01) but we mirror upstream verbatim. The card is
    // still dispatched as SI9 by range (cardNumber 1234567 -> SI9 range 1M-2M).
    // See for the rationale (range > series for Phase 0).
    cardSeries: 'SiCard10',
    cardNumber: 1234567,
    startTime: 51921,
    finishTime: null,
    checkTime: 51935,
    punchCount: 16,
    punches: [
      { code: 31, time: 51167 },
      { code: 32, time: 8224 },
      { code: 33, time: 51681 },
      { code: 34, time: 8738 },
      { code: 35, time: 52195 },
      { code: 36, time: 9252 },
      { code: 37, time: 52709 },
      { code: 38, time: 9766 },
      { code: 39, time: 53223 },
      { code: 40, time: 10280 },
      { code: 41, time: 53737 },
      { code: 42, time: 10794 },
      { code: 43, time: 54251 },
      { code: 44, time: 11308 },
      { code: 45, time: 54765 },
      { code: 46, time: 11822 },
    ],
    cardHolder: {
      firstName: 'a',
      lastName: 'b',
      isComplete: true,
    },
  },
  storageData: [
    ...unPrettyHex(`
      77 2A 42 99 EA EA EA EA 37 02 22 1F 07 03 22 11
      EE EE EE EE 0F 7F 10 09 0F 12 D6 87 06 0F 61 53
      61 3B 62 3B EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE 1F 1F 1F 1F 20 20 20 20
      21 21 21 21 22 22 22 22 23 23 23 23 24 24 24 24
      25 25 25 25 26 26 26 26 27 27 27 27 28 28 28 28
      29 29 29 29 2A 2A 2A 2A 2B 2B 2B 2B 2C 2C 2C 2C
      2D 2D 2D 2D 2E 2E 2E 2E EE EE EE EE EE EE EE EE
    `),
    ...noTimesPage,
  ],
};
