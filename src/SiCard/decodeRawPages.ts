// Authored for lool. Not ported from upstream.
//
// Decode a `RawPages` snapshot (or a sanitised copy of one) the way a real
// read does, without a station.

import type { BaseSiCard } from './BaseSiCard.ts';
import { RAW_BLOCK_SIZE, type RawPages } from './rawPages.ts';
import { SiCard5 } from './types/SiCard5.ts';
import { SiCard6 } from './types/SiCard6.ts';
import { SiCard8 } from './types/SiCard8.ts';
import { SiCard9 } from './types/SiCard9.ts';
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

/** Build a card of `raw.cardType` from the listed blocks and run the decoder.
 * The card number comes from the bytes; unlisted bytes stay unread. */
export const decodeRawPages = (raw: RawPages): BaseSiCard => {
  const Card = Object.hasOwn(CARD_CLASSES, raw.cardType) ? CARD_CLASSES[raw.cardType] : undefined;
  if (!Card) throw new Error(`decodeRawPages: unknown card type ${String(raw.cardType)}`);
  const bytes: (number | undefined)[] = [];
  for (const { block, bytes: b } of raw.blocks) {
    if (b.length !== RAW_BLOCK_SIZE) {
      throw new Error(
        `decodeRawPages: block ${block} has ${b.length} bytes, expected ${RAW_BLOCK_SIZE}`
      );
    }
    bytes.length = Math.max(bytes.length, (block + 1) * RAW_BLOCK_SIZE);
    bytes.splice(block * RAW_BLOCK_SIZE, RAW_BLOCK_SIZE, ...b);
  }
  const card = new Card(0);
  (card as unknown as { _decodeFromStorage(b: (number | undefined)[]): void })._decodeFromStorage(
    bytes
  );
  return card;
};
