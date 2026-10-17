// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/modernSiCardExamples.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Specifically: the `getEmptyCard` export — modern card with no punches.
// punchCount = 0, punches = [], cardHolder fields all undefined / isComplete=false.
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
  name: 'empty-card (upstream modern getEmptyCard)',
  cardData: {
    uid: 0x772a4299,
    cardSeries: 'SiCard10',
    cardNumber: 7050892,
    startTime: 8721,
    finishTime: null,
    checkTime: 8735,
    punchCount: 0,
    punches: [],
    cardHolder: {
      firstName: undefined,
      lastName: undefined,
      gender: undefined,
      birthday: undefined,
      club: undefined,
      email: undefined,
      phone: undefined,
      city: undefined,
      street: undefined,
      zip: undefined,
      country: undefined,
      isComplete: false,
    },
  },
  storageData: [
    ...unPrettyHex(`
      77 2A 42 99 EA EA EA EA 37 02 22 1F 07 03 22 11
      EE EE EE EE 0F 7F 00 09 0F 6B 96 8C 06 0F 61 53
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
      EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE EE
    `),
    ...emptyPage,
    ...emptyPage,
    ...emptyPage,
    ...noTimesPage,
    ...noTimesPage,
    ...noTimesPage,
    ...noTimesPage,
  ],
};
