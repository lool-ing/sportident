// Derived from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/modernSiCardExamples.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// LOCAL DERIVATION (upstream lacks a SIAC-range fixture): based on getCardWith16Punches
// modern fixture, with the card number bytes at offsets [0x19, 0x1A, 0x1B] rewritten so
// the decoded cardNumber falls in 8M-9M (SIAC range per BaseSiCard.registerSi8Range).
// The cardholder + punches sections remain byte-identical to upstream's 16-punch fixture.
//
// arr2cardNumber([params[5], params[4], params[3]]) i.e. ([b1B, b1A, b19]) -> assembling as:
//   cardnum = (b1A << 8) | b1B; if (b19 != 0x00 && b19 <= 4)  cardnum += b19 * 100000
//                              ; else if (b19 > 4 || four-byte-form)  cardnum |= b19 << 16
// Need value in [8_000_000, 9_000_000). Pick exactly 8_500_000 = 0x80, 0xC0, 0xC0:
//   0x80 0xC0 0xC0 -> (0xC0 << 16) | (0xC0 << 8) | 0x80
// LooL: times whose punch record has PTD bit 0 (PM) set are +43200 vs upstream,
// because LooL decodes the PM flag and upstream does not.
//                  -> 0xC0_C0_80 = 12_632_192? Let's recompute.
// Per arr2cardNumber: arr is [b19, b1A, b1B]. We get back arr by [params[5], params[4], params[3]]
// = [b1B, b1A, b19] reversed by the storage's SiArray(3, i -> [[0x19 + (2-i)]]) i.e.
// position-0 reads byte 0x1B, position-1 reads byte 0x1A, position-2 reads byte 0x19.
// arr2cardNumber on [b1B, b1A, b19] sets `cardnum = (b1A<<8) | b1B; if (b19>4) cardnum |= b19<<16`.
// b1B=0x80, b1A=0xB5, b19=0x81. cardnum = (0xB5<<8) | 0x80 = 0xB580; cardnum |= 0x81<<16 ->
// 0x81B580 = 8_500_608. Falls in [8_000_000, 9_000_000) i.e. SIAC's registered SI8 range.
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
  name: 'SIAC-derived (upstream modern getCardWith16Punches w/ cardNumber rewritten to 8.5M)',
  cardData: {
    uid: 0x772a4299,
    cardSeries: 'SiCard10', // Series byte 0x0F resolves to 'SiCard10' (first-declared key
    // wins on collision). The SIAC routing in BaseSiCard.detectFromMessage uses range
    // 8M-9M, NOT the series label.
    cardNumber: 8_500_608,
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
  // Byte 0x19, 0x1A, 0x1B carry the SI card number bytes. Originals upstream:
  //   0x19 = 0x6B, 0x1A = 0x96, 0x1B = 0x8C -> cardNumber = 7050892 (SI10 range).
  // We rewrite to 0x81 0xB5 0x80 so cardNumber decodes to 8_500_096 (SIAC range).
  storageData: [
    ...unPrettyHex(`
      77 2A 42 99 EA EA EA EA 37 02 22 1F 07 03 22 11
      EE EE EE EE 0F 7F 10 09 0F 81 B5 80 06 0F 61 53
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
