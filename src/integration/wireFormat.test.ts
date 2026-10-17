// Authored for lool. Not ported from upstream.
// Regression tests for the real-wire response format.
//
// REGRESSION: bench bug 2026-05-13 — SiStorage.splice fired with
//   "removed 128, inserted 130"
// on every live-card read against a real BSM7 station, because SiCard5 /
// ModernSiCard / BaseSiStation skipped only [cmd, len] (or [cmd, len, pageNo])
// of the response header — missing the 2-byte station address that the
// station always emits between LEN and the payload.
//
// This test drives the FakeSerialTransport with frames whose `parameters`
// section matches the live-hardware capture in
// `tests/fixtures/bench/si9-bench-001.bytes.hex`:
//
//   GET_SYS_VAL response: 02 83 83 00 0A 00 [128 cfg] CRC CRC 03
//                                  ^addr_hi addr_lo offset_echo
//   GET_SI5     response: 02 B1 [LEN] 00 0A [128 data] CRC CRC 03
//                                       ^addr_hi addr_lo
//   GET_SI8     response: 02 EF 83 00 0A 00 [128 page] CRC CRC 03
//                                  ^addr_hi addr_lo page_no
//
// If a consumer regresses back to slicing only 2/3/4 bytes off the response,
// SiStorage.splice will fire its length-mismatch invariant — same symptom as
// the original 2026-05-13 bench crash.
//
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { render } from '../siProtocol.ts';
import { proto } from '../constants.ts';
import { STATION_CONFIG_OFFSETS, StationMode } from '../SiStation/BaseSiStation.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { SiMainStation } from '../SiStation/SiMainStation.ts';
import { SiCard5 } from '../SiCard/types/SiCard5.ts';
import { SiCard9 } from '../SiCard/types/SiCard9.ts';

import { fixture as si5Fixture } from '../../tests/fixtures/upstream/si5-16-punches.ts';
import { fixture as si9Fixture } from '../../tests/fixtures/upstream/si9-typical.ts';

// ---------------------------------------------------------------------------
// FakeSerialTransport — local copy (kept self-contained so this file doesn't
// import from sibling test scaffolds).
// ---------------------------------------------------------------------------

type SendMatcher = (chunk: number[]) => boolean;
type SendHandler = (chunk: number[]) => number[] | void;

class FakeSerialTransport extends EventEmitter implements ISerialTransport {
  public recordedSends: number[][] = [];
  private rules: { matcher: SendMatcher; handler: SendHandler }[] = [];
  private closed = false;

  open(): Promise<void> {
    return Promise.resolve();
  }

  send(bytes: number[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'));
    this.recordedSends.push(bytes);
    const rule = this.rules.find((r) => r.matcher(bytes));
    if (rule) {
      const resp = rule.handler(bytes);
      if (resp !== undefined) setImmediate(() => this.emit('data', resp));
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    setImmediate(() => this.emit('close'));
    return Promise.resolve();
  }

  addRule(matcher: SendMatcher, handler: SendHandler): void {
    this.rules.push({ matcher, handler });
  }

  inject(bytes: number[]): void {
    setImmediate(() => this.emit('data', bytes));
  }
}

const renderFrame = (command: number, parameters: number[]): number[] =>
  render({ command, parameters });

// Station address captured on the bench (code 10).
const STATION_ADDR_HI = 0x00;
const STATION_ADDR_LO = 0x0a;

const makeStationConfigBlob = (): number[] => {
  const cfg = new Array<number>(128).fill(0x00);
  // Plausible pre-handshake state so writeDiff has actual diff work to do.
  cfg[STATION_CONFIG_OFFSETS.MODE] = StationMode.Workstation;
  cfg[STATION_CONFIG_OFFSETS.CODE_LOW] = 1;
  return cfg;
};

/**
 * Install the real-wire handshake rules. The shapes here are 1:1 with
 * `tests/fixtures/bench/si9-bench-001.bytes.hex` (modulo CRC, which `render`
 * recomputes).
 */
const setUpRealWireHandshake = (fake: FakeSerialTransport): void => {
  fake.addRule(
    (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.SET_MS,
    () => renderFrame(proto.cmd.SET_MS, [STATION_ADDR_HI, STATION_ADDR_LO, proto.P_MS_DIRECT])
  );
  fake.addRule(
    (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.GET_SYS_VAL,
    () =>
      // 131-byte param block = [addr_hi, addr_lo, offset_echo, ...128 cfg]
      renderFrame(proto.cmd.GET_SYS_VAL, [
        STATION_ADDR_HI,
        STATION_ADDR_LO,
        0x00,
        ...makeStationConfigBlob(),
      ])
  );
  fake.addRule(
    (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.SET_SYS_VAL,
    (c) => renderFrame(proto.cmd.SET_SYS_VAL, [STATION_ADDR_HI, STATION_ADDR_LO, c[4] as number])
  );
};

const buildSi5DetFrame = (cardNumber: number): number[] => {
  const mid = Math.floor(cardNumber / 100000) & 0xff;
  const residual = cardNumber - mid * 100000;
  const hi = (residual >> 8) & 0xff;
  const lo = residual & 0xff;
  return renderFrame(proto.cmd.SI5_DET, [0x00, 0x00, 0x00, mid, hi, lo]);
};

const buildSi8DetFrame = (cardNumber: number, seriesByte: number): number[] => {
  const lo = cardNumber & 0xff;
  const hi = (cardNumber >> 8) & 0xff;
  const mid = (cardNumber >> 16) & 0xff;
  return renderFrame(proto.cmd.SI8_DET, [0x00, 0x00, seriesByte, mid, hi, lo]);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wire-format regression: real-hardware response shapes pass through end-to-end', () => {
  test('GET_SI5 with [addr_hi, addr_lo, ...128 data] -> SiCard5 populates raceResult without splice mismatch', async () => {
    // REGRESSION: bench bug 2026-05-13 — splice removed 128, inserted 130.
    // This test FAILS if SiCard5.typeSpecificRead reverts to frame.slice(2).
    const fake = new FakeSerialTransport();
    setUpRealWireHandshake(fake);
    const station = new SiMainStation(fake);
    await fake.open();
    await station.readCards();

    // Real-wire GET_SI5 response: [STX, B1, LEN, addr_hi, addr_lo, ...128 data, CRC, CRC, ETX].
    fake.addRule(
      (c) => c[0] === proto.WAKEUP && c[2] === proto.cmd.GET_SI5,
      () =>
        renderFrame(proto.cmd.GET_SI5, [
          STATION_ADDR_HI,
          STATION_ADDR_LO,
          ...(si5Fixture.storageData as number[]),
        ])
    );

    const inserted: unknown[] = [];
    const read: unknown[] = [];
    const errors: Error[] = [];
    station.on('cardInserted', (card: unknown) => inserted.push(card));
    station.on('cardRead', (card: unknown) => read.push(card));
    station.on('error', (err: Error) => errors.push(err));

    fake.inject(buildSi5DetFrame(si5Fixture.cardData.cardNumber));
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(
      errors.length,
      0,
      `no errors expected; got: ${errors.map((e) => e.message).join('; ')}`
    );
    assert.strictEqual(inserted.length, 1, 'cardInserted emitted once');
    assert.ok(inserted[0] instanceof SiCard5, 'inserted as SiCard5 (legacy registry)');
    assert.strictEqual(read.length, 1, 'cardRead emitted once');

    const card = read[0] as SiCard5;
    // Card number decoded from the page payload (proves splice landed on the
    // right offset — slice(4) consumed the addr bytes correctly).
    assert.strictEqual(card.raceResult.cardNumber, si5Fixture.cardData.cardNumber);
    // Punch count survives — the splice didn't truncate or shift the data.
    assert.strictEqual(
      card.raceResult.punches?.length,
      (si5Fixture.cardData.punches as unknown[]).length
    );

    await station.close();
  });

  test('GET_SI8 with [addr_hi, addr_lo, page_no, ...128 data] -> SiCard9 populates raceResult without splice mismatch', async () => {
    // REGRESSION: bench bug 2026-05-13 — modern card flow had the same splice
    // length mismatch via ModernSiCard.typeSpecificGetPage's frame.slice(3).
    // This test FAILS if ModernSiCard reverts to frame.slice(3) — the splice
    // would receive 130 bytes and trip the SiStorage invariant.
    const fake = new FakeSerialTransport();
    setUpRealWireHandshake(fake);
    const station = new SiMainStation(fake);
    await fake.open();
    await station.readCards();

    const bytesPerPage = 128;
    // Real-wire GET_SI8 response per page: [cmd, len, addr_hi, addr_lo, page_no, ...128 data, CRC, CRC, ETX]
    fake.addRule(
      (c) => c[0] === proto.WAKEUP && c[2] === proto.cmd.GET_SI8,
      (c) => {
        const pageNumber = c[4] as number;
        const start = pageNumber * bytesPerPage;
        const pageBytes = (si9Fixture.storageData as number[]).slice(start, start + bytesPerPage);
        return renderFrame(proto.cmd.GET_SI8, [
          STATION_ADDR_HI,
          STATION_ADDR_LO,
          pageNumber,
          ...pageBytes,
        ]);
      }
    );

    const inserted: unknown[] = [];
    const read: unknown[] = [];
    const errors: Error[] = [];
    station.on('cardInserted', (card: unknown) => inserted.push(card));
    station.on('cardRead', (card: unknown) => read.push(card));
    station.on('error', (err: Error) => errors.push(err));

    fake.inject(buildSi8DetFrame(si9Fixture.cardData.cardNumber, 0x01));
    await new Promise((r) => setTimeout(r, 80));

    assert.strictEqual(
      errors.length,
      0,
      `no errors expected; got: ${errors.map((e) => e.message).join('; ')}`
    );
    assert.strictEqual(inserted.length, 1, 'cardInserted emitted once');
    assert.ok(inserted[0] instanceof SiCard9, 'inserted as SiCard9 (modern registry)');
    assert.strictEqual(read.length, 1, 'cardRead emitted once');

    const card = read[0] as SiCard9;
    // Card number lives on page 0 — splice(5) must consume [cmd, len, addr_hi,
    // addr_lo, page_no] to land the page-0 payload at storage offset 0.
    assert.strictEqual(card.raceResult.cardNumber, si9Fixture.cardData.cardNumber);
    assert.strictEqual(
      card.raceResult.punches?.length,
      (si9Fixture.cardData.punches as unknown[]).length,
      'punch count survived the multi-page splice chain'
    );

    await station.close();
  });

  test('GET_SYS_VAL with [addr_hi, addr_lo, offset_echo, ...128 cfg] -> BaseSiStation.readInfo reads the right 128 bytes', async () => {
    // Tighter unit-style test: prove the readInfo() offset arithmetic survives
    // the real-wire 5-byte header. If headerLen regresses to 4, the SN bytes
    // will be off-by-1 and writeDiff's bit-merge against bytes 0x73/0x74 will
    // silently target the wrong bits.
    const fake = new FakeSerialTransport();
    // Build a config blob where each byte's value equals its offset, so any
    // shift error is trivially detectable: cfg[i] === i for all 128 bytes.
    const knownConfig = new Array<number>(128);
    for (let i = 0; i < 128; i++) knownConfig[i] = i;
    fake.addRule(
      (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.SET_MS,
      () => renderFrame(proto.cmd.SET_MS, [STATION_ADDR_HI, STATION_ADDR_LO, proto.P_MS_DIRECT])
    );
    fake.addRule(
      (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.GET_SYS_VAL,
      () =>
        renderFrame(proto.cmd.GET_SYS_VAL, [STATION_ADDR_HI, STATION_ADDR_LO, 0x00, ...knownConfig])
    );
    // SET_SYS_VAL echo (handshake mutates the config, so writeDiff fires).
    fake.addRule(
      (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.SET_SYS_VAL,
      (c) => renderFrame(proto.cmd.SET_SYS_VAL, [STATION_ADDR_HI, STATION_ADDR_LO, c[4] as number])
    );

    // Reach into BaseSiStation directly — readCards() does the whole flow but
    // we want to assert the configBytes shape before writeDiff mutates anything.
    const station = new SiMainStation(fake);
    await fake.open();
    // We deliberately go through readCards() so the full handshake path runs.
    await station.readCards();

    // Reconstruct the post-handshake config by replaying SET_SYS_VAL sends —
    // same technique as SiMainStation.test.ts. Each on-wire SET_SYS_VAL chunk:
    //   [WAKEUP, STX, cmd, len, offset, ...bytes, crc_hi, crc_lo, ETX]
    const reconstructed = knownConfig.slice();
    for (const chunk of fake.recordedSends) {
      if (chunk[0] !== proto.WAKEUP) continue;
      if (chunk[1] !== proto.STX) continue;
      if (chunk[2] !== proto.cmd.SET_SYS_VAL) continue;
      const len = chunk[3] as number;
      const offset = chunk[4] as number;
      const numDataBytes = len - 1;
      for (let i = 0; i < numDataBytes; i++) {
        reconstructed[offset + i] = chunk[5 + i] as number;
      }
    }

    // The handshake writes byte 0x71 (mode) -> Readout. If headerLen regresses
    // to 4, the readInfo()-captured blob is shifted so the bit-merge for
    // bytes 0x73 and 0x74 happens against the WRONG source bytes, and the
    // write at byte 0x71 ends up incorrect.
    assert.strictEqual(
      reconstructed[STATION_CONFIG_OFFSETS.MODE],
      StationMode.Readout,
      `byte 0x71 must be Readout; got 0x${reconstructed[STATION_CONFIG_OFFSETS.MODE]?.toString(16)}`
    );
    // CODE_LOW (byte 0x72) is set by the handshake to 10. Pre-handshake source
    // value at offset 0x72 was 0x72 (== offset, by our knownConfig setup). If
    // headerLen had been 4, that source value would have been read as 0x71
    // (off-by-one) — but since the handshake unconditionally OVERWRITES this
    // byte, that alone wouldn't catch the regression. So we instead assert on
    // a byte the handshake DOES NOT touch: byte 0x10 (random middle byte)
    // must equal its source value 0x10 in `reconstructed`.
    assert.strictEqual(
      reconstructed[0x10],
      0x10,
      `byte 0x10 must equal its source value (0x10); got 0x${reconstructed[0x10]?.toString(16)} — ` +
        `if this is 0x0F, headerLen regressed to 4`
    );

    await station.close();
  });
});
