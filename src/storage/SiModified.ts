// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/storage/SiModified.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications: read-only extract; SiStorageData is a plain array.
// See NOTICE.md for cumulative attribution.

import { SiDataType, type SiStorageData } from './SiDataType.ts';

export class SiModified<T, U> extends SiDataType<U> {
  public readonly dataType: SiDataType<T>;
  public readonly modifyExtracted: (value: T) => U | undefined;
  constructor(dataType: SiDataType<T>, modifyExtracted: (value: T) => U | undefined) {
    super();
    this.dataType = dataType;
    this.modifyExtracted = modifyExtracted;
  }

  typeSpecificExtractFromData(data: SiStorageData): U | undefined {
    const internalData = this.dataType.typeSpecificExtractFromData(data);
    if (internalData === undefined) return undefined;
    return this.modifyExtracted(internalData);
  }
}
