// Ported (simplified) from allestuetsmerweh/sportident.js — packages/sportident/src/SiStation/BaseSiStation.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Stripped lodash; no enums.
//   - Trimmed to the Phase 0 surface: `readInfo()` (GET_SYS_VAL 0..128) + `writeDiff()`
//     (SET_SYS_VAL for each contiguous dirty byte-range). Storage-typed station-config
//     parsing is NOT ported — Phase 0 treats the 128-byte blob as a plain `number[]`
//     and mutates known offsets directly. The flag layout below mirrors upstream's
//     `siStationStorageLocations` (BaseSiStation.ts L41-86): most readout-mode
//     fields are BITS inside bytes 0x73/0x74 rather than whole-byte slots.
//   - Mode constants exported as a const literal (no enum — erasableSyntaxOnly).
// See NOTICE.md for cumulative attribution.

import { proto } from '../constants.ts';
import type { SiMessage } from '../siProtocol.ts';
import type { ISiStation } from './ISiStation.ts';

/**
 * Station-config byte offsets and bit positions exercised by SiMainStation.readCards().
 *
 * Upstream sportident.js stores the readout-mode flags (autoSend, handshake, beeps,
 * flashes, extProto, …) as BITS inside bytes 0x73 and 0x74, not as whole-byte values.
 * The previous shape of this constants object got this wrong: it treated 0x73/0x74/0x75/0x76
 * as if each flag owned a whole byte, AND it placed CODE at 0x02 (which is in fact the
 * third byte of the 4-byte big-endian serial number at offset 0..3). Writing CODE there
 * corrupted the bench station's reported SN from 593656 → 593144 on 2026-05-13
 * (see tests/fixtures/bench/si9-bench-001.bytes.hex for the
 * captured pre-corruption SI9 transcript). Worse, the handshake bit at 0x74 bit 2
 * never actually got set, which is why the station never emits SI_CARD_DETECTED.
 */
export const STATION_CONFIG_OFFSETS = {
  /** Serial number bytes [0..3] (big-endian). DO NOT WRITE here — readout only. */
  SERIAL_NUMBER: { offset: 0x00, length: 4 },
  /**
   * Station code low byte (whole byte). High 2 bits live in byte 0x73 bits 6:7.
   * readCards() leaves the code alone.
   */
  CODE_LOW: 0x72,
  /** Station mode (whole byte: 0x05 = Readout). */
  MODE: 0x71,
  /**
   * Bit-packed flag byte: flashes (bit 0), beeps (bit 2), code-high-bits (6:7).
   * Other bits in this byte belong to upstream features we don't touch.
   */
  FLAG_BYTE_73: 0x73,
  /**
   * Bit-packed flag byte: extProto (bit 0), autoSend (bit 1), handshake (bit 2),
   * sprint4ms (3), passwordOnly (4), stopOnFullBackup (5), autoReadout (7).
   * Preserve bits we don't explicitly set/clear so we don't silently change
   * unrelated station behaviour configured by other operators.
   */
  FLAG_BYTE_74: 0x74,
} as const;

/** Bit masks inside byte 0x73. */
export const FLAG_BITS_73 = {
  FLASHES: 1 << 0,
  BEEPS: 1 << 2,
  CODE_HIGH_MASK: 0b11 << 6,
} as const;

/** Bit masks inside byte 0x74. */
export const FLAG_BITS_74 = {
  EXT_PROTO: 1 << 0,
  AUTO_SEND: 1 << 1,
  HANDSHAKE: 1 << 2,
} as const;

/** Station-mode byte values per upstream `BaseSiStation.Mode`. */
export const StationMode = {
  Readout: 0x05,
  Workstation: 0x12,
  Control: 0x02,
  Start: 0x03,
  Finish: 0x04,
} as const;

export class BaseSiStation {
  protected station: ISiStation;
  public configBytes: number[] = [];

  constructor(station: ISiStation) {
    this.station = station;
  }

  /**
   * Read the first 128 bytes of station config (GET_SYS_VAL offset=0,
   * length=128). Stores them in `this.configBytes`.
   */
  async readInfo(): Promise<number[]> {
    const responses = await this.station.sendMessage({
      command: proto.cmd.GET_SYS_VAL,
      parameters: [0x00, 0x80],
    });
    const frame = responses[0];
    if (!frame) throw new Error('GET_SYS_VAL returned no response');
    // Frame is [cmd, len, ...params]. Real-wire GET_SYS_VAL response carries
    // [addr_hi, addr_lo, offset_echo, ...128 data] in `parameters` (bench
    // transcript 2026-05-13: 02 83 83 00 0A 00 [128 data] ...). Skip
    // [cmd, len, addr_hi, addr_lo, offset_echo] = 5 bytes; the 128-byte config
    // blob follows. Previous headerLen=4 dropped the addr_lo and shifted the
    // config blob by 1, which corrupted the bit-packed handshake flags at
    // 0x73/0x74 (and the SN at 0x00..0x03 read 1 byte too late, returning
    // 593144 instead of 593656 — see fixtures/bench/si9-bench-001).
    const headerLen = 5;
    this.configBytes = frame.slice(headerLen, headerLen + 128);
    return this.configBytes;
  }

  /**
   * Diff `oldConfig` vs `newConfig` byte-by-byte; send a SET_SYS_VAL for each
   * contiguous dirty range. Returns the number of writes performed.
   */
  async writeDiff(oldConfig: number[], newConfig: number[]): Promise<number> {
    if (oldConfig.length !== newConfig.length) {
      throw new Error(
        `writeDiff: length mismatch (old=${oldConfig.length}, new=${newConfig.length})`
      );
    }
    let writes = 0;
    let rangeStart = -1;
    const flushRange = async (rangeEnd: number): Promise<void> => {
      if (rangeStart < 0) return;
      const slice = newConfig.slice(rangeStart, rangeEnd + 1);
      const message: SiMessage = {
        command: proto.cmd.SET_SYS_VAL,
        parameters: [rangeStart & 0xff, ...slice],
      };
      await this.station.sendMessage(message);
      writes++;
      rangeStart = -1;
    };

    for (let i = 0; i < newConfig.length; i++) {
      if (oldConfig[i] !== newConfig[i]) {
        if (rangeStart < 0) rangeStart = i;
      } else if (rangeStart >= 0) {
        await flushRange(i - 1);
      }
    }
    if (rangeStart >= 0) await flushRange(newConfig.length - 1);
    return writes;
  }
}
