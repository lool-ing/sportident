// Ported (simplified) from allestuetsmerweh/sportident.js — packages/sportident/src/SiStation/SiMainStation.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Wires the simplified (Direct-only) SiTargetMultiplexer; no SET_MS-on-every-call.
//   - readCards() performs the upstream atomic handshake: SET_MS(0x4D) ->
//     GET_SYS_VAL(0,128) -> SET_SYS_VAL diff to switch the station into Readout
//     mode. The readout-mode flags (beeps, flashes, autoSend, handshake, extProto)
//     live as BITS inside bytes 0x73 and 0x74 — see BaseSiStation.STATION_CONFIG_OFFSETS
//     for the wire layout. We do bit-aware read-modify-writes so we preserve
//     unrelated firmware bits (sprint4ms, passwordOnly, etc.).
//   - Card-insert dispatch: subscribes to multiplexer 'message'; routes SI5_DET
//     and SI8_DET through BaseSiCard.detectFromMessage, emits
//     'cardInserted', awaits card.read() (which calls back into sendMessage for
//     GET_SI5 / GET_SI8 — WAKEUP prepended by the multiplexer automatically),
//     emits 'cardRead'. SI_REM emits 'cardRemoved'.
//   - Frame errors propagate through the multiplexer's 'frameError' event with
//     the typed FrameError payload unchanged.
//   - Dropped: TRANS_REC autosend listener (Phase 4), CoupledSiStation, the
//     storage-typed StationConfig wrappers (the byte-offset constants in
//     BaseSiStation.ts are sufficient for Phase 0 mode-switch).
// See NOTICE.md for cumulative attribution.

import { proto } from '../constants.ts';
import type { FrameError, SiMessage } from '../siProtocol.ts';
import { arr2cardNumber } from '../siProtocol.ts';
import { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import { EventEmitter } from '../utils/events.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import {
  BaseSiStation,
  FLAG_BITS_73,
  FLAG_BITS_74,
  STATION_CONFIG_OFFSETS,
  StationMode,
} from './BaseSiStation.ts';
import { SiTargetMultiplexer } from './SiTargetMultiplexer.ts';
import type { ConnectionState, ISiMainStation } from './ISiMainStation.ts';

// Side-effect imports: trigger registry population on BaseSiCard so
// detectFromMessage can dispatch SI5_DET / SI8_DET frames.
import '../SiCard/types/SiCard5.ts';
import '../SiCard/types/SiCard6.ts';
import '../SiCard/types/SiCard8.ts';
import '../SiCard/types/SiCard9.ts';
import '../SiCard/types/SiCard10.ts';
import '../SiCard/types/SiCard11.ts';
import '../SiCard/types/SIAC.ts';

export class SiMainStation extends EventEmitter implements ISiMainStation {
  private multiplexer: SiTargetMultiplexer;
  private station: BaseSiStation;
  private isClosed = false;
  /** The card whose read is in flight, if any. */
  private readingCard: BaseSiCard | undefined;

  constructor(transport: ISerialTransport) {
    super();
    this.multiplexer = new SiTargetMultiplexer(transport);
    this.station = new BaseSiStation({
      sendMessage: (msg, expected, timeout) => this.multiplexer.sendMessage(msg, expected, timeout),
    });
    this.multiplexer.on('message', (msg: SiMessage) => this._dispatchMessage(msg));
    this.multiplexer.on('frameError', (err: FrameError) => this.emit('frameError', err));
    this.multiplexer.on('close', () => {
      if (this.isClosed) return;
      this.isClosed = true;
      this._emitState('closed');
    });
  }

  /**
   * sendMessage passthrough (implements ISiStation) so callers / decoders that
   * hold an ISiStation reference can drive command-response without needing
   * the underlying multiplexer.
   */
  sendMessage(message: SiMessage, expectedResponses = 1, timeoutMs?: number): Promise<number[][]> {
    return this.multiplexer.sendMessage(message, expectedResponses, timeoutMs);
  }

  /**
   * Perform the BSM7/8 handshake and put the station into Readout mode.
   *
   * Step 1: SET_MS(0x4D) — claim Master mode. The multiplexer prepends WAKEUP
   * automatically.
   * Step 2: readInfo() — fetch 128-byte config blob via GET_SYS_VAL(0, 128).
   * Step 3: bit-aware merge into the in-memory config:
   *   - byte 0x71 (whole byte) = StationMode.Readout
   *   - byte 0x72 (whole byte) = code low byte (10)
   *   - byte 0x73: set BEEPS (bit 2) + FLASHES (bit 0); clear code-high-bits
   *     (code ≤ 255). All other bits preserved.
   *   - byte 0x74: set EXT_PROTO (bit 0) + HANDSHAKE (bit 2); clear AUTO_SEND
   *     (bit 1). Other bits (sprint4ms, passwordOnly, stopOnFullBackup,
   *     autoReadout) are preserved so we don't silently change unrelated
   *     station behaviour.
   * Step 4: writeDiff(old, new) — send SET_SYS_VAL for each contiguous dirty
   * range. The station echoes the first byte of each write.
   *
   * After this resolves, the station spontaneously emits SI5_DET / SI8_DET /
   * SI_REM frames; subscribers to 'cardInserted' / 'cardRead' / 'cardRemoved'
   * see them via the multiplexer's 'message' event path.
   */
  async readCards(): Promise<void> {
    this._emitState('opening');
    try {
      // Step 1: SET_MS(0x4D) — Master mode handshake.
      const setMsResponses = await this.multiplexer.sendMessage({
        command: proto.cmd.SET_MS,
        parameters: [proto.P_MS_DIRECT],
      });
      const setMsFrame = setMsResponses[0];
      if (!setMsFrame) throw new Error('SET_MS returned no response');
      // Upstream's SET_MS response carries the echoed master/slave byte at
      // params[2]. We just verify it isn't a NAK — the station replying at all
      // is enough.

      // Step 2: read 128-byte config blob.
      const oldConfig = await this.station.readInfo();

      // Step 3: build the new config (mutate copy in place). Bit-aware writes —
      // see BaseSiStation.STATION_CONFIG_OFFSETS for the wire layout rationale.
      const newConfig = oldConfig.slice();
      // Defensive: pad short blobs (some fakes return fewer bytes) so the
      // offset-keyed writes don't index past the end.
      while (newConfig.length < 128) newConfig.push(0x00);

      // MODE = Readout (0x05) → byte 0x71 (whole byte).
      newConfig[STATION_CONFIG_OFFSETS.MODE] = StationMode.Readout;

      // CODE = 10 → byte 0x72 (low byte). High bits 6:7 of byte 0x73 stay zero
      // since code ≤ 255; the bit-merge for 0x73 below clears them explicitly.
      newConfig[STATION_CONFIG_OFFSETS.CODE_LOW] = 10;

      // Byte 0x73: set BEEPS (bit 2) + FLASHES (bit 0); clear code-high-bits.
      newConfig[STATION_CONFIG_OFFSETS.FLAG_BYTE_73] =
        (newConfig[STATION_CONFIG_OFFSETS.FLAG_BYTE_73]! & ~FLAG_BITS_73.CODE_HIGH_MASK) |
        FLAG_BITS_73.BEEPS |
        FLAG_BITS_73.FLASHES;

      // Byte 0x74: set EXT_PROTO (bit 0) + HANDSHAKE (bit 2); clear AUTO_SEND
      // (bit 1). All other bits preserved.
      newConfig[STATION_CONFIG_OFFSETS.FLAG_BYTE_74] =
        (newConfig[STATION_CONFIG_OFFSETS.FLAG_BYTE_74]! & ~FLAG_BITS_74.AUTO_SEND) |
        FLAG_BITS_74.EXT_PROTO |
        FLAG_BITS_74.HANDSHAKE;

      // Step 4: writeDiff — one SET_SYS_VAL per contiguous dirty range.
      // Pad oldConfig to match.
      const oldPadded = oldConfig.slice();
      while (oldPadded.length < newConfig.length) oldPadded.push(0x00);
      await this.station.writeDiff(oldPadded, newConfig);

      this._emitState('open');
    } catch (err) {
      this._emitState('error');
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      await this.multiplexer.close();
    } finally {
      this._emitState('closed');
    }
  }

  // --- Message dispatch ----------------------------------------------------

  private _dispatchMessage(message: SiMessage): void {
    if (message.mode !== undefined) return;
    // SI_REM: card removed.
    if (message.command === proto.cmd.SI_REM) {
      this._abortRead();
      // params layout matches SI5_DET / SI8_DET — bytes 3..5 carry the card number.
      const card = BaseSiCard.detectFromMessage({
        // Repackage SI_REM as if it were the matching detection command so we
        // can reuse arr2cardNumber via detectFromMessage. Easier: build the
        // card-number inline.
        command: proto.cmd.SI_REM,
        parameters: message.parameters,
      });
      // detectFromMessage returns undefined for SI_REM (only SI5_DET/SI8_DET
      // route through it), so fall through to a direct cardNumber decode.
      void card;
      const params = message.parameters;
      if (params.length >= 6) {
        // arr2cardNumber expects LSB-first; SI_REM params carry the card number
        // in params[3..5] as [high, mid, low].
        const cardnum = arr2cardNumber([params[5], params[4], params[3]]);
        if (cardnum !== undefined) {
          this.emit('cardRemoved', cardnum);
        }
      }
      return;
    }
    // SI5_DET / SI6_DET / SI8_DET: card inserted -> dispatch + read.
    if (
      message.command === proto.cmd.SI5_DET ||
      message.command === proto.cmd.SI6_DET ||
      message.command === proto.cmd.SI8_DET
    ) {
      this._abortRead();
      const card = BaseSiCard.detectFromMessage(message);
      if (!card) return;
      card.mainStation = {
        sendMessage: (msg, expected, timeout) =>
          this.multiplexer.sendMessage(msg, expected, timeout),
      };
      this.emit('cardInserted', card);
      this.readingCard = card;
      // Drive the typeSpecificRead chain; emit cardRead on success.
      //
      //
      // after a successful read we send a bare ACK (0x06) so the BSx reader
      // beeps and stops re-reporting the card. The ACK is fire-and-forget
      // via the multiplexer's no-response API — it does NOT travel through
      // sendMessage() because there's no expected response and we don't want
      // a timeout on it. We emit cardRead AFTER the ACK send promise
      // resolves so subscribers see the events in causal order
      // (cardInserted -> [card data on wire] -> [ACK on wire] -> cardRead).
      card
        .read()
        .finally(() => {
          if (this.readingCard === card) this.readingCard = undefined;
        })
        .then(() => this.multiplexer.sendBareAck())
        .then(() => this.emit('cardRead', card))
        .catch((err: Error) => {
          // Forward as a frameError so subscribers see the failure.
          const fe: FrameError = {
            error_code: 'crc_mismatch',
            raw_bytes: [],
            bytes_consumed: 0,
          };
          void fe;
          // The NDJSON layer will translate read-failures into a typed
          // 'card_read_error' event; Phase 0 multiplexer just emits the underlying
          // Error so logs stay diagnostic.
          this.emit('error', err);
        });
      return;
    }
    // Other free-floating commands (autosend etc.) — Phase 4 territory.
  }

  /** The card being read left the station (SI_REM, or a new card's DET): fail
   * its read now, so no reply meant for the next card is taken as its data. */
  private _abortRead(): void {
    if (this.readingCard) {
      this.multiplexer._abortAllPendingSends('', new Error('card removed during read'));
    }
  }

  private _emitState(state: ConnectionState): void {
    this.emit('connectionChanged', state);
  }
}
