// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/storage/SiStorage.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Backed by `(number|undefined)[]` (plain array) instead of `Immutable.List` so
//     we don't pull in `immutable` as a dep. Splice/get are mutating; that's fine
//     because each card decode creates a fresh `SiStorage` instance.
//   - Trimmed to the surface Phase 0 actually uses: get + splice. The set/update
//     path is not exercised by the decoders.
// See NOTICE.md for cumulative attribution.

import { SiDataType, type SiStorageData } from './SiDataType.ts';

export type SiStorageLocations<Fields> = {
  [id in keyof Fields]: SiDataType<Fields[id]>;
};

export class SiStorage<T> {
  private internalData: (number | undefined)[];
  public readonly size: number;
  public readonly locations: SiStorageLocations<T>;

  constructor(size: number, locations: SiStorageLocations<T>, initArg?: (number | undefined)[]) {
    this.size = size;
    this.locations = locations;
    if (initArg === undefined) {
      this.internalData = new Array<number | undefined>(size).fill(undefined);
    } else if (initArg.length === size) {
      this.internalData = initArg.slice();
    } else {
      throw new Error(
        `SiStorage init data has length ${initArg.length} but storage size is ${size}`
      );
    }
  }

  get data(): SiStorageData {
    return this.internalData;
  }

  get<U extends keyof T>(fieldName: U): { value: T[U] } | undefined {
    const fieldDefinition = this.locations[fieldName];
    return fieldDefinition.extractFromData(this.internalData);
  }

  splice(index: number, removeNum: number, ...values: number[]): void {
    if (removeNum !== values.length) {
      throw new Error(
        `SiStorage.splice must preserve length (removed ${removeNum}, inserted ${values.length})`
      );
    }
    // In-place splice — replicates Immutable.List.splice for our read-only use.
    for (let i = 0; i < values.length; i++) {
      this.internalData[index + i] = values[i];
    }
  }
}

export const defineStorage =
  <T>(size: number, locations: SiStorageLocations<T>) =>
  (initArg?: (number | undefined)[]): SiStorage<T> =>
    new SiStorage<T>(size, locations, initArg);
