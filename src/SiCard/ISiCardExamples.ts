// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/ISiCardExamples.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// See NOTICE.md for cumulative attribution.

export interface SiCardSample {
  cardData: { [attr: string]: unknown } & { cardNumber: number };
  storageData: (number | undefined)[];
}
