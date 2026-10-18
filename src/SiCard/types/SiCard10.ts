// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/SiCard10.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Registers on the SI8_DET-only registry via `BaseSiCard.registerSi8Range` —
//     enforces that SiCard10 NEVER captures SI5_DET messages.
//   - No lodash; no enums.
// See NOTICE.md for cumulative attribution.

import { BaseSiCard } from '../BaseSiCard.ts';
import { ModernSiCard } from './ModernSiCard.ts';

export class SiCard10 extends ModernSiCard {
  readonly cardType = 'SI10' as const;
}

BaseSiCard.registerSi8Range(7_000_000, 8_000_000, SiCard10);
