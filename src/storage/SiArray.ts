// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/storage/SiArray.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Stripped lodash (`_.range` -> `Array.from({length: n}, (_, i) => i)`).
//   - Read-only extract (no update path; Phase 0 only decodes).
//   - SiStorageData is a plain array, not Immutable.List.
// See NOTICE.md for cumulative attribution.

import { SiDataType, type SiStorageData } from './SiDataType.ts';

export type SiArrayValue<T> = (T | undefined)[];

export class SiArray<T> extends SiDataType<SiArrayValue<T>> {
  public length: number;
  public getDefinitionAtIndex: (index: number) => SiDataType<T>;
  constructor(length: number, getDefinitionAtIndex: (index: number) => SiDataType<T>) {
    super();
    this.length = length;
    this.getDefinitionAtIndex = getDefinitionAtIndex;
  }

  typeSpecificExtractFromData(data: SiStorageData): SiArrayValue<T> | undefined {
    const out: SiArrayValue<T> = [];
    for (let i = 0; i < this.length; i++) {
      const definition = this.getDefinitionAtIndex(i);
      const itemFieldValue = definition.extractFromData(data);
      out.push(itemFieldValue === undefined ? undefined : itemFieldValue.value);
    }
    return out;
  }
}
