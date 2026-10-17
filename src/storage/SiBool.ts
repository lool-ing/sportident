// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/storage/SiBool.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications: read-only extract; SiStorageData is a plain array.
// See NOTICE.md for cumulative attribution.

import { SiDataType, type SiStorageData } from './SiDataType.ts';

export class SiBool extends SiDataType<boolean> {
  private byteOffset: number;
  private bitOffset: number;
  constructor(byteOffset: number, bitOffset = 0) {
    super();
    this.byteOffset = byteOffset;
    this.bitOffset = bitOffset;
  }

  typeSpecificExtractFromData(data: SiStorageData): boolean | undefined {
    const existingByte = data[this.byteOffset];
    if (existingByte === undefined) return undefined;
    return ((existingByte >> this.bitOffset) & 0x01) === 0x01;
  }
}
