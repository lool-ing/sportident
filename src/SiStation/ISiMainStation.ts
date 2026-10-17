// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiStation/ISiMainStation.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications: trimmed to the Phase 0 surface — readCards() + close()
// + the SiMainStation event surface (cardInserted/cardRead/cardRemoved/
// frameError/connectionChanged). Dropped CoupledSiStation / autosend hooks.
// See NOTICE.md for cumulative attribution.

import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import type { FrameError } from '../siProtocol.ts';
import type { ISiStation } from './ISiStation.ts';

export type ConnectionState = 'opening' | 'open' | 'closed' | 'error';

export interface SiMainStationEvents {
  cardInserted: (card: BaseSiCard) => void;
  cardRead: (card: BaseSiCard) => void;
  cardRemoved: (cardNumber: number) => void;
  frameError: (err: FrameError) => void;
  connectionChanged: (state: ConnectionState) => void;
}

export interface ISiMainStation extends ISiStation {
  readCards(): Promise<void>;
  close(): Promise<void>;
}
