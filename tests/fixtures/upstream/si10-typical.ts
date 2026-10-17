// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/modernSiCardExamples.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Specifically: the `getCardWith16Punches` modern export. cardData + storageData copied byte-for-byte.
// LooL: times whose punch record has PTD bit 0 (PM) set are +43200 vs upstream,
// because LooL decodes the PM flag and upstream does not.
// Card number 7050892 -> SI10 range (7M-8M). Series byte at offset 0x18 = 0x0F (SiCard10).
// punches: 16 (single-page punch read — exercises page 4 only).
// See NOTICE.md for cumulative attribution.

import { unPrettyHex } from '../../../src/utils/bytes.ts';
import type { SiCardSample } from '../../../src/SiCard/ISiCardExamples.ts';

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
  name: 'SI10-typical (upstream modern getCardWith16Punches)',
  cardData: {
    uid: 0x772a4299,
    // Series byte 0x0F resolves to the first-declared key in ModernSiCardSeries
    // ('SiCard10' wins over SIAC; range still drives card-type dispatch — see
    // in BaseSiCard.ts).
    cardSeries: 'SiCard10',
    cardNumber: 7050892,
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
    ...unPrettyHex(`
      77 2A 42 99 EA EA EA EA 37 02 22 1F 07 03 22 11
      EE EE EE EE 0F 7F 10 09 0F 6B 96 8C 06 0F 61 53
      61 3B 62 3B 63 3B 64 3B 65 3B 66 3B 67 3B 68 3B
      69 3B 6A 3B 6B 3B EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
    `),
    ...emptyPage,
    ...emptyPage,
    ...emptyPage,
    ...unPrettyHex(`
      1F 1F 1F 1F 20 20 20 20 21 21 21 21 22 22 22 22
      23 23 23 23 24 24 24 24 25 25 25 25 26 26 26 26
      27 27 27 27 28 28 28 28 29 29 29 29 2A 2A 2A 2A
      2B 2B 2B 2B 2C 2C 2C 2C 2D 2D 2D 2D 2E 2E 2E 2E
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
    `),
    ...noTimesPage,
    ...noTimesPage,
    ...noTimesPage,
  ],
};
