// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiStation/ISiMainStation.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications: trimmed to the Phase 0 surface — readCards() + close()
// + the SiMainStation event surface (cardInserted/cardRead/cardRemoved/
// frameError/connectionChanged), cardRead with a confirm. Dropped CoupledSiStation / autosend hooks.
// See NOTICE.md for cumulative attribution.

import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import type { FrameError } from '../siProtocol.ts';
import type { ISiStation } from './ISiStation.ts';

export type ConnectionState = 'opening' | 'open' | 'closed' | 'error';

/** A card detection whose number no supported card type covers. Not read, not
 * ACKed; `seriesByte` is SI8_DET's params[2]. */
export interface UnsupportedCard {
  cardNumber: number;
  command: number;
  seriesByte?: number;
}

export interface SiMainStationEvents {
  cardInserted: (card: BaseSiCard) => void;
  /** `confirm` sends the ACK (the station's beep), once; with confirmReads
   * the read waits for it, otherwise it is already sent. */
  cardRead: (card: BaseSiCard, confirm: () => Promise<void>) => void;
  cardRemoved: (cardNumber: number) => void;
  cardUnsupported: (card: UnsupportedCard) => void;
  frameError: (err: FrameError) => void;
  connectionChanged: (state: ConnectionState) => void;
}

export interface ISiMainStation extends ISiStation {
  readCards(): Promise<void>;
  close(): Promise<void>;
}
