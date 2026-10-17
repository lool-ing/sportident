// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/storage/SiDataType.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Backed by a plain `(number|undefined)[]` array instead of `Immutable.List` (Phase 0
//     decodes are read-only; the immutable.js dep is not worth carrying).
//   - Removed `valueToString` / `valueFromString` / `update` machinery (only `extract` is
//     exercised by Phase 0 decoders).
//   - Stripped lodash. No enums.
// See NOTICE.md for cumulative attribution.

export type SiStorageData = readonly (number | undefined)[];

export abstract class SiDataType<T> {
  /**
   * Extract a typed value from the storage byte array. Returns `undefined` when
   * required bytes are unavailable (out of range or set to undefined upstream).
   */
  abstract typeSpecificExtractFromData(data: SiStorageData): T | undefined;

  extractFromData(data: SiStorageData): { value: T } | undefined {
    const v = this.typeSpecificExtractFromData(data);
    if (v === undefined) return undefined;
    return { value: v };
  }
}
