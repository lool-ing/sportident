// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/storage/SiInt.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Read-only extract (no update path; Phase 0 only decodes).
//   - SiStorageData is a plain array, not Immutable.List.
//   - Stripped lodash (`_.isInteger` not needed in the extract path).
// See NOTICE.md for cumulative attribution.

import { SiDataType, type SiStorageData } from './SiDataType.ts';

export type SiIntegerPartDefinition = [number, number, number] | [number];

export interface SiIntegerPart {
  byteOffset: number;
  startBit: number;
  endBit: number;
}

/**
 * Reads a single integer split across one or more byte parts. Each part can
 * specify a sub-byte bit slice via the 3-tuple form `[offset, startBit, endBit]`
 * (defaults: 0..8 for the 1-tuple form). Bits from successive parts are
 * concatenated little-endian on the bit axis.
 */
export class SiInt extends SiDataType<number> {
  public parts: SiIntegerPart[];

  constructor(parts: SiIntegerPartDefinition[]) {
    super();
    this.parts = parts.map((rawPart) => ({
      byteOffset: rawPart[0],
      startBit: rawPart.length === 3 ? rawPart[1] : 0,
      endBit: rawPart.length === 3 ? rawPart[2] : 8,
    }));
  }

  isUndefined(data: SiStorageData): boolean {
    return this.parts.some((part) => data[part.byteOffset] === undefined);
  }

  typeSpecificExtractFromData(data: SiStorageData): number | undefined {
    if (this.isUndefined(data)) return undefined;
    let bitOffset = 0;
    let intValue = 0;
    for (const part of this.parts) {
      const { byteOffset, startBit, endBit } = part;
      const bitLength = endBit - startBit;
      const lengthMask = (0x01 << bitLength) - 1;
      const existingByte = data[byteOffset] as number;
      const partValue = (existingByte >> startBit) & lengthMask;
      intValue |= partValue << bitOffset;
      bitOffset += bitLength;
    }
    return intValue;
  }
}
