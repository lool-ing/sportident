// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiStation/ISiStation.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications: trimmed to the Phase 0 surface; sendMessage signature
// uses our simplified number[][] return shape (one entry per response frame
// matching the requested expectedResponse count).
// See NOTICE.md for cumulative attribution.

import type { SiMessage } from '../siProtocol.ts';

export interface ISiStation {
  sendMessage(
    message: SiMessage,
    expectedResponses?: number,
    timeoutMs?: number
  ): Promise<number[][]>;
}
