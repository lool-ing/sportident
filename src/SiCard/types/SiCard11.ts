// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/SiCard11.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Registers on the SI8_DET-only registry via `BaseSiCard.registerSi8Range`,
//     like SiCard10 (same memory layout, ModernSiCard).
// See NOTICE.md for cumulative attribution.

import { BaseSiCard } from '../BaseSiCard.ts';
import { ModernSiCard } from './ModernSiCard.ts';

export class SiCard11 extends ModernSiCard {}

BaseSiCard.registerSi8Range(9_000_000, 10_000_000, SiCard11);
