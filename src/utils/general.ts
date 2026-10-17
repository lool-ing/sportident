// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/utils/general.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications: trimmed to the surface Phase 0 actually uses (`cached`, `getLookup`,
//   `waitFor`). `binarySearch` left out — none of the Phase 0 ports need it. No lodash; no enums.
// See NOTICE.md for cumulative attribution.

export type Cache<T> = { [id: string]: T };

/**
 * Returns a memoized getter for a parameterless thunk. Cache is shared across
 * invocations via the `cache` argument so callers can scope it as needed.
 */
export const cached = <T>(cache: Cache<T>, getThing: () => T): (() => T) => {
  const getter = (): T => {
    const getThingIdent = `${getThing.name}-${getThing.toString()}`;
    const cachedThing = cache[getThingIdent];
    if (cachedThing === undefined) {
      const newThing = getThing();
      cache[getThingIdent] = newThing;
      return newThing;
    }
    return cachedThing;
  };
  return getter;
};

export type Lookup = { [id: string]: string };
export type MappingWithLookup<T> = { [id: string]: T | string | Lookup };

/**
 * Build a reverse-lookup table from a value→name mapping. Memoizes on the mapping
 * object itself via a `_lookup` field (same pattern as upstream).
 */
export const getLookup = <T>(
  mapping: MappingWithLookup<T>,
  getLookupKey?: (value: T) => string
): Lookup => {
  if (mapping._lookup) {
    return mapping._lookup as Lookup;
  }
  const lookup: Lookup = {};
  Object.keys(mapping)
    .filter((mappingKey) => mappingKey.slice(0, 1) !== '_')
    .forEach((mappingKey) => {
      const mappingValue = mapping[mappingKey];
      const lookupKey = getLookupKey ? getLookupKey(mappingValue as T) : (mappingValue as string);
      if (lookupKey in lookup) {
        throw new Error(`Duplicate lookup key: ${lookupKey}`);
      }
      lookup[lookupKey] = mappingKey;
    });
  mapping._lookup = lookup;
  return lookup;
};

export const waitFor = <T>(milliseconds: number, value?: T): Promise<T | undefined> =>
  new Promise<T | undefined>((resolve) => {
    setTimeout(() => resolve(value), milliseconds);
  });
