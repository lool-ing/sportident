// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/storage/SiDict.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications: read-only extract; SiStorageData is a plain array.
// See NOTICE.md for cumulative attribution.

import { SiDataType, type SiStorageData } from './SiDataType.ts';

export type SiDictValue<T> = { [key in keyof T]: T[key] | undefined };
export type SiPartialDictValue<T> = { [key in keyof T]?: T[key] };

export class SiDict<T> extends SiDataType<SiDictValue<T>> {
  public readonly definitionDict: { [key in keyof T]: SiDataType<T[key]> };
  constructor(definitionDict: { [key in keyof T]: SiDataType<T[key]> }) {
    super();
    this.definitionDict = definitionDict;
  }

  typeSpecificExtractFromData(data: SiStorageData): SiDictValue<T> {
    const dictValue: SiPartialDictValue<T> = {};
    for (const key of this.keysOfT) {
      const definition = this.definitionDict[key];
      const itemFieldValue = definition.extractFromData(data);
      if (itemFieldValue === undefined) continue;
      dictValue[key] = itemFieldValue.value;
    }
    return dictValue as SiDictValue<T>;
  }

  get keysOfT(): (keyof T)[] {
    return Object.keys(this.definitionDict) as (keyof T)[];
  }
}
