// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/storage/SiEnum.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Read-only extract (no update path); SiStorageData is a plain array.
//   - Local non-throwing reverse-lookup (NOT `utils.getLookup`): when two keys
//     share the same int value (e.g. SiCard10 and SIAC both = 0x0F), the FIRST
//     declared key wins. The shared `getLookup` helper throws on duplicates,
//     which is wrong for ModernSiCardSeries where multiple card types share
//     series byte 0x0F. (Phase 0 dispatches such ambiguity by card-number range,
//     so the series label is forensic only #4.)
// See NOTICE.md for cumulative attribution.

import { SiDataType, type SiStorageData } from './SiDataType.ts';
import { SiInt, type SiIntegerPartDefinition } from './SiInt.ts';

export class SiEnum<T extends { [key: string]: number }> extends SiDataType<keyof T> {
  private intField: SiInt;
  public readonly dict: T;
  public readonly getIntValue: (value: unknown) => number | undefined;
  private cachedLookup: { [key: string]: string } | undefined;

  constructor(
    parts: SiIntegerPartDefinition[],
    dict: T,
    getIntValue: (value: unknown) => number | undefined = (value): number => value as number
  ) {
    super();
    this.intField = new SiInt(parts);
    this.dict = dict;
    this.getIntValue = getIntValue;
  }

  getLookupDict(): { [key: string]: string } {
    if (this.cachedLookup !== undefined) return this.cachedLookup;
    const lookup: { [key: string]: string } = {};
    for (const key of Object.keys(this.dict)) {
      if (key.startsWith('_')) continue;
      const intValue = this.getIntValue(this.dict[key]);
      if (intValue === undefined) continue;
      const lookupKey = String(intValue);
      // First-declared-key wins on collisions (SiCard10 and SIAC
      // share 0x0F; the dispatch logic uses range, not series).
      if (!(lookupKey in lookup)) {
        lookup[lookupKey] = key;
      }
    }
    this.cachedLookup = lookup;
    return lookup;
  }

  typeSpecificExtractFromData(data: SiStorageData): keyof T | undefined {
    const intValue = this.intField.typeSpecificExtractFromData(data);
    if (intValue === undefined) return undefined;
    const lookupDict = this.getLookupDict();
    const key = lookupDict[String(intValue)];
    return key as keyof T | undefined;
  }
}
