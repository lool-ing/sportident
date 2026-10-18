// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/SIAC.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Registers on the SI8_DET-only registry via `BaseSiCard.registerSi8Range` —
//     enforces that SIAC NEVER captures SI5_DET messages.
//   - No lodash; no enums.
//   - Reads block 3 (battery, versions): readsBlock3 = true.
// See NOTICE.md for cumulative attribution.
//
// TODO: find out the series value and remove this hack.
// Upstream comment: SIAC and SiCard11 both share series byte 0x0F with SiCard10,
// so Phase 0 dispatches purely by card-number range. #4.
// Phase 0 dispatch is by number range; the SI8_DET series byte (params[2]) is
// recorded on the instance for forensic NDJSON emission only.

import { BaseSiCard } from '../BaseSiCard.ts';
import { ModernSiCard } from './ModernSiCard.ts';

export class SIAC extends ModernSiCard {
  readonly cardType = 'SIAC' as const;
  static override readsBlock3 = true;

  /** Always read block 1 on SIAC (SPORTident (Thomas, 2026-10-13), answer 12),
   * whatever the records and firmware; its codes are only used on 4.0+. */
  override typeSpecificReadCodeBlock(): Promise<void> {
    return this.block1Read ? Promise.resolve() : this.readBlock1();
  }
}

BaseSiCard.registerSi8Range(8_000_000, 9_000_000, SIAC);
