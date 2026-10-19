// Authored for lool. Not ported from upstream.
//
// Raw card memory as the station returned it, and the byte ranges inside it
// that hold personal data. The library only exposes both; sanitising and
// storing are the consumer's job.

import type { CardType } from '../output/ndjson.ts';

export const RAW_BLOCK_SIZE = 128;

export interface RawBlock {
  /** Block (page) number as requested from the station; bytes are card
   * addresses `block * 128 .. block * 128 + 127`. */
  block: number;
  /** Copy of the 128 bytes the station returned for this block. */
  bytes: Uint8Array;
}

export interface RawPages {
  cardType: CardType;
  layout: RawLayoutName;
  /** Only blocks the reader fetched, in ascending order. A block that is not
   * listed was never read; a listed block is complete. */
  blocks: RawBlock[];
}

export type RawLayoutName = 'si5' | 'si6' | 'si8' | 'si9' | 'modern';

export interface PersonalRange {
  kind: 'holder' | 'uid';
  /** Card addresses, inclusive on both ends. */
  from: number;
  to: number;
}

export interface RawLayout {
  layout: RawLayoutName;
  /** True for every current layout. A future layout whose ranges are not
   * known would set it false with `personal` empty, which must not be read as
   * "no personal data". */
  personalRangesVerified: boolean;
  personal: PersonalRange[];
}

const holder = (from: number, to: number): PersonalRange => ({ kind: 'holder', from, to });
const uid: PersonalRange = { kind: 'uid', from: 0x00, to: 0x03 };

// Ranges follow SPORTident's card data structure document and may be wider
// than what a decoder reads (SI8 owner area runs to 0x87, the decoder reads
// 0x20 + 0x60): do not shrink them to decoder offsets. The race fields next
// to them (card number 0x19-0x1B, SI8 punches from 0x88, SI9 from 0x38,
// modern punches from block 4, SIAC codes at 0xA4-0xA9) are outside.
const modern: RawLayout = {
  layout: 'modern',
  personalRangesVerified: true,
  personal: [uid, holder(0x20, 0x9f)],
};

export const RAW_LAYOUTS: Record<
  'SI5' | 'SI6' | 'SI8' | 'SI9' | 'SI10' | 'SI11' | 'SIAC',
  RawLayout
> = {
  SI5: { layout: 'si5', personalRangesVerified: true, personal: [holder(0x01, 0x03)] },
  // SI6 and SI6* share this layout. No chip serial: 0x00-0x03 is the layout
  // version. The clear record 0x20-0x23 stays.
  SI6: {
    layout: 'si6',
    personalRangesVerified: true,
    personal: [
      // Block 0: the owner's programmed start number (0x28-0x2B; no decoder
      // reads it), 4 undefined bytes, then names, country and club, per
      // SPORTident card data structure document.
      holder(0x28, 0x7f),
      // Block 1, never fetched: user id, phone, e-mail, address, sex, birth
      // date; production date 0xFC-0xFF left out, per SPORTident card data
      // structure document.
      holder(0x80, 0xfb),
    ],
  },
  // Owner area runs to 0x87, past the decoder's 0x60 bytes; punches start at
  // 0x88, per SPORTident card data structure document.
  SI8: { layout: 'si8', personalRangesVerified: true, personal: [uid, holder(0x20, 0x87)] },
  SI9: { layout: 'si9', personalRangesVerified: true, personal: [uid, holder(0x20, 0x37)] },
  SI10: modern,
  SI11: modern,
  SIAC: modern,
};

/** Copy every fully read 128-byte block out of a storage buffer. */
export const snapshotBlocks = (data: ReadonlyArray<number | undefined>): RawBlock[] => {
  const blocks: RawBlock[] = [];
  for (let b = 0; b * RAW_BLOCK_SIZE < data.length; b++) {
    const slice = data.slice(b * RAW_BLOCK_SIZE, (b + 1) * RAW_BLOCK_SIZE);
    if (slice.length === RAW_BLOCK_SIZE && slice.every((v) => v !== undefined)) {
      blocks.push({ block: b, bytes: Uint8Array.from(slice as number[]) });
    }
  }
  return blocks;
};
