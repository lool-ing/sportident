// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/siCard5Examples.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Specifically: the `getFullCard` export. cardData + storageData copied byte-for-byte.
// Exercises the slot-30-to-35 codes-only path: punches 31-36 have code=0x20 with time=null.
// See NOTICE.md for cumulative attribution.

import { unPrettyHex } from '../../../src/utils/bytes.ts';
import type { SiCardSample } from '../../../src/SiCard/ISiCardExamples.ts';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

export const fixture: SiCardSample & { name: string } = {
  name: 'SI5-full (upstream)',
  cardData: {
    cardNumber: 406402,
    startTime: 7643,
    finishTime: 7727,
    checkTime: 7632,
    punchCount: 36,
    punches: [
      ...range(30).map(() => ({ code: 32, time: 8224 })),
      ...range(6).map(() => ({ code: 32, time: null })),
    ],
    cardHolder: {
      countryCode: 0x29, // = 41
      clubCode: 0x01,
    },
    softwareVersion: 0x28, // = 40
  },
  storageData: [
    ...unPrettyHex(`
      AA 29 00 01 19 02 04 00 00 00 00 00 00 00 00 00
      65 19 02 1D DB 1E 2F 25 56 1D D0 28 04 1F 00 07
      20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
      20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
      20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
      20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
      20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
      20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
    `),
  ],
};
