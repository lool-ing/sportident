// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/modernSiCardExamples.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Specifically: the `getCardWith64Punches` modern export. cardData + storageData copied byte-for-byte.
// LooL: times whose punch record has PTD bit 0 (PM) set are +43200 vs upstream,
// because LooL decodes the PM flag and upstream does not.
// punchCount = 64 (0x40), card number 7050892 (SI10 range). Exercises the multi-page punch
// read sequence: typeSpecificReadPunches issues GET_SI8 page 4 AND page 5.
// See NOTICE.md for cumulative attribution.

import { unPrettyHex } from '../../../src/utils/bytes.ts';
import type { SiCardSample } from '../../../src/SiCard/ISiCardExamples.ts';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const emptyPage = unPrettyHex(`
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
`);
// `getFullTimesPage` per upstream: 128 bytes of 0x20 — interpreted as 32 punches each
// {day=0x20, code=0x20, time_hi=0x20, time_lo=0x20}. time = (0x20<<8)|0x20 = 0x2020 = 8224.
const fullTimesPage = unPrettyHex(`
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
  20 20 20 20 20 20 20 20 20 20 20 20 20 20 20 20
`);
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
  name: 'SI10-64-punches (upstream modern getCardWith64Punches)',
  cardData: {
    uid: 0x772a4299,
    cardSeries: 'SiCard10',
    cardNumber: 7050892,
    startTime: 51921,
    finishTime: null,
    checkTime: 51935,
    punchCount: 64,
    punches: range(64).map(() => ({ code: 32, time: 8224 })),
    cardHolder: {
      firstName: 'a',
      lastName: 'b',
      gender: 'c',
      birthday: 'd',
      club: 'e',
      email: 'f',
      phone: 'g',
      city: 'h',
      street: 'i',
      zip: 'j',
      country: 'k',
      isComplete: true,
    },
  },
  storageData: [
    // Page 0 — punchCount byte at offset 0x16 = 0x40 = 64.
    ...unPrettyHex(`
      77 2A 42 99 EA EA EA EA 37 02 22 1F 07 03 22 11
      EE EE EE EE 0F 7F 40 09 0F 6B 96 8C 06 0F 61 53
      61 3B 62 3B 63 3B 64 3B 65 3B 66 3B 67 3B 68 3B
      69 3B 6A 3B 6B 3B EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
    `),
    ...emptyPage, // page 1 (cardholder cont.)
    ...emptyPage, // page 2
    ...emptyPage, // page 3
    ...fullTimesPage, // page 4 — 32 punches
    ...fullTimesPage, // page 5 — 32 more punches (multi-page!)
    ...noTimesPage, // page 6
    ...noTimesPage, // page 7
  ],
};
