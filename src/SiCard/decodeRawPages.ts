// Authored for lool. Not ported from upstream.
//
// Decode a `RawPages` snapshot (or a sanitised copy of one) the way a real
// read does, without a station.

import type { BaseSiCard } from './BaseSiCard.ts';
import { RAW_BLOCK_SIZE, RAW_LAYOUTS, type RawPages } from './rawPages.ts';
import { SiCard5 } from './types/SiCard5.ts';
import { SiCard6, getPunchOffset as si6Offset } from './types/SiCard6.ts';
import { SiCard8, getPunchOffset as si8Offset } from './types/SiCard8.ts';
import { SiCard9, getPunchOffset as si9Offset } from './types/SiCard9.ts';
import { getPunchOffset as modernOffset } from './types/ModernSiCard.ts';
import { SiCard10 } from './types/SiCard10.ts';
import { SiCard11 } from './types/SiCard11.ts';
import { SIAC } from './types/SIAC.ts';

const CARD_CLASSES: Record<string, new (cardNumber: number) => BaseSiCard> = {
  SI5: SiCard5,
  SI6: SiCard6,
  SI8: SiCard8,
  SI9: SiCard9,
  SI10: SiCard10,
  SI11: SiCard11,
  SIAC,
};

// SI5 keeps everything in block 0, which is always required.
const PUNCH_OFFSET: Record<string, (i: number) => number> = {
  SI6: si6Offset,
  SI8: si8Offset,
  SI9: si9Offset,
  SI10: modernOffset,
  SI11: modernOffset,
  SIAC: modernOffset,
};

/** Build a card of `raw.cardType` from the listed blocks and run the decoder.
 * The card number comes from the bytes; unlisted bytes stay unread. Throws a
 * "malformed RawPages" error for an unknown card type, a layout that does not
 * match, a block that is not a whole number within the card or is repeated,
 * block 0 missing, bytes that are not a 128-byte Uint8Array, or listed blocks
 * that do not cover the punch slots the punch count says exist (the decoder
 * may still return fewer punches, e.g. at an invalid slot). */
export const decodeRawPages = (raw: RawPages): BaseSiCard => {
  const Card = Object.hasOwn(CARD_CLASSES, raw.cardType) ? CARD_CLASSES[raw.cardType] : undefined;
  if (!Card) throw new Error(`decodeRawPages: unknown card type ${String(raw.cardType)}`);
  if (raw.layout !== RAW_LAYOUTS[raw.cardType as keyof typeof RAW_LAYOUTS].layout) {
    throw new Error(`decodeRawPages: layout ${String(raw.layout)} does not match ${raw.cardType}`);
  }
  if (!Array.isArray(raw.blocks)) throw new Error('decodeRawPages: blocks must be an array');
  const card = new Card(0);
  const blockCount = card.storage.data.length / RAW_BLOCK_SIZE;
  const bytes: (number | undefined)[] = [];
  const seen = new Set<number>();
  for (const { block, bytes: b } of raw.blocks) {
    if (!Number.isInteger(block) || block < 0 || block >= blockCount || seen.has(block)) {
      throw new Error(
        `decodeRawPages: block ${String(block)} is not a single block 0-${blockCount - 1} of ${raw.cardType}`
      );
    }
    seen.add(block);
    if (!(b instanceof Uint8Array)) {
      throw new Error(`decodeRawPages: block ${String(block)} bytes must be a Uint8Array`);
    }
    if (b.length !== RAW_BLOCK_SIZE) {
      throw new Error(
        `decodeRawPages: block ${block} has ${b.length} bytes, expected ${RAW_BLOCK_SIZE}`
      );
    }
    bytes.length = Math.max(bytes.length, (block + 1) * RAW_BLOCK_SIZE);
    bytes.splice(block * RAW_BLOCK_SIZE, RAW_BLOCK_SIZE, ...b);
  }
  if (!seen.has(0)) {
    throw new Error('decodeRawPages: block 0 holds the card number and must be listed');
  }
  card.decodeFromStorage(bytes);
  const offset = PUNCH_OFFSET[raw.cardType];
  const max = (Card as unknown as { maxNumPunches: number }).maxNumPunches;
  const count = Math.min(card.punchCount ?? 0, max);
  for (let i = 0; offset && i < count; i++) {
    for (const addr of [offset(i), offset(i) + 3]) {
      const need = Math.floor(addr / RAW_BLOCK_SIZE);
      if (!seen.has(need)) {
        throw new Error(
          `decodeRawPages: ${raw.cardType} punch count is ${card.punchCount} but block ${need}, which holds punch ${i}, is not listed`
        );
      }
    }
  }
  return card;
};
