// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/utils/bytes.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications: replaced `substr` (deprecated) with `slice`; no other behavioral changes.
//   No lodash; no enums.
// See NOTICE.md for cumulative attribution.

export const isByte = (byte: unknown): boolean =>
  Number(byte) === byte &&
  Math.floor(byte as number) === byte &&
  (byte as number) <= 0xff &&
  (byte as number) >= 0x00;

export const isByteArr = (arr: unknown): boolean =>
  Array.isArray(arr) && !arr.some((e) => !isByte(e));

export function assertIsByteArr(arr: unknown): asserts arr is number[] {
  if (!isByteArr(arr)) {
    throw new Error(`${String(arr)} is not a byte array`);
  }
}

export const isArrOfLengths = (arr: unknown[], lengths: number[]): boolean => {
  const actualLength = arr.length;
  return lengths.some((length) => actualLength === length);
};

export const assertArrIsOfLengths = (arr: unknown[], lengths: number[]): void => {
  if (!isArrOfLengths(arr, lengths)) {
    throw new Error(`${String(arr)} is not of lengths ${String(lengths)}`);
  }
};

export const arr2big = (arr: number[]): number => {
  assertIsByteArr(arr);
  let outnum = 0;
  for (let i = 0; i < arr.length; i++) {
    const byte = arr[i] as number;
    outnum += byte * Math.pow(0x100, arr.length - i - 1);
  }
  return outnum;
};

export const prettyHex = (input: string | (number | undefined)[], lineLength = 0): string => {
  let iterable: (number | undefined)[];
  if (typeof input === 'string') {
    iterable = [];
    for (let strIndex = 0; strIndex < input.length; strIndex++) {
      iterable.push(input.charCodeAt(strIndex));
    }
  } else {
    iterable = input;
  }
  const prettyBytes = iterable
    .map((byte) => (byte !== undefined ? `00${byte.toString(16)}` : '??'))
    .map((paddedStr) => paddedStr.slice(-2).toUpperCase());
  if (lineLength === 0) {
    return prettyBytes.join(' ');
  }
  const lines: string[] = [];
  for (let lineIndex = 0; lineIndex < prettyBytes.length / lineLength; lineIndex++) {
    const startIndex = lineIndex * lineLength;
    const endIndex = (lineIndex + 1) * lineLength;
    const line = prettyBytes.slice(startIndex, endIndex).join(' ');
    lines.push(line);
  }
  return lines.join('\n');
};

export const unPrettyHex = (input: string): Array<number | undefined> => {
  const hexString = input.replace(/\s/g, '');
  if (hexString.length % 2 !== 0) {
    throw new Error('Hex String length must be even');
  }
  const byteArray: Array<number | undefined> = [];
  for (let byteIndex = 0; byteIndex < hexString.length / 2; byteIndex++) {
    const hexByteString = hexString.slice(byteIndex * 2, byteIndex * 2 + 2);
    const byteValue = hexByteString === '??' ? undefined : parseInt(hexByteString, 16);
    if (
      byteValue !== undefined &&
      (!Number.isInteger(byteValue) || byteValue < 0 || byteValue > 255)
    ) {
      throw new Error(`Invalid hex: ${hexByteString}`);
    }
    byteArray.push(byteValue);
  }
  return byteArray;
};
