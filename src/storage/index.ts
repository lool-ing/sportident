// Authored for lool. Not ported from upstream.
// Storage primitive barrel.
// Re-exports the per-file storage data types and the SiStorage composite. See each
// file's NOTICE header for upstream attribution.

export { SiDataType, type SiStorageData } from './SiDataType.ts';
export { SiInt, type SiIntegerPart, type SiIntegerPartDefinition } from './SiInt.ts';
export { SiArray, type SiArrayValue } from './SiArray.ts';
export { SiDict, type SiDictValue, type SiPartialDictValue } from './SiDict.ts';
export { SiBool } from './SiBool.ts';
export { SiEnum } from './SiEnum.ts';
export { SiModified } from './SiModified.ts';
export { SiStorage, defineStorage, type SiStorageLocations } from './SiStorage.ts';
