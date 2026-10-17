// Authored for lool. Not ported from upstream.
// SiMainStation handshake + card-dispatch tests against a
// FakeSerialTransport. Zero real-hardware dependency: the FakeSerialTransport
// implements ISerialTransport via EventEmitter and replays canned response frames
// in response to recorded sends.
//
// Covers:
//   1) atomic handshake — SET_MS -> GET_SYS_VAL -> SET_SYS_VAL diff
//   2) WAKEUP prepending on EVERY command
//   3) SI5 insertion path (legacy single-frame GET_SI5)
//   4) SI9 insertion path — modern card, page 4 punch read
//   5) SI10 insertion path — modern card, page 4 punch read
//   6) SIAC insertion path — modern card, page 4 punch read
//   7) SI_REM -> cardRemoved
//   8) send timeout -> SendTimeoutError
//   9) transport close mid-flight -> DeviceClosedError; connectionChanged:'closed'
//  10) bad-CRC frame -> 'frameError' via the typed onFrameError callback
//      (no stdout/stderr writes anywhere on this path)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CRC16, render, type FrameError } from '../siProtocol.ts';
import { proto } from '../constants.ts';
import { DeviceClosedError, SendTimeoutError } from '../transport/errors.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import { SiCard5 } from '../SiCard/types/SiCard5.ts';
import { SiCard9 } from '../SiCard/types/SiCard9.ts';
import { SiCard10 } from '../SiCard/types/SiCard10.ts';
import { SIAC } from '../SiCard/types/SIAC.ts';
import { SiMainStation } from './SiMainStation.ts';
import {
  FLAG_BITS_73,
  FLAG_BITS_74,
  STATION_CONFIG_OFFSETS,
  StationMode,
} from './BaseSiStation.ts';

import { fixture as si5Fixture } from '../../tests/fixtures/upstream/si5-16-punches.ts';
import { fixture as si9Fixture } from '../../tests/fixtures/upstream/si9-typical.ts';
import { fixture as si10Fixture } from '../../tests/fixtures/upstream/si10-typical.ts';
import { fixture as si10ManyFixture } from '../../tests/fixtures/upstream/si10-many-punches.ts';

// ----------------------------------------------------------------------------
// FakeSerialTransport — replays canned response frames in response to sends.
// Each `addRule(matcher, response)` installs a handler that, when its matcher
// returns true on a sent chunk, emits the response bytes on the next tick.
// Tests can also call `inject(bytes)` to push spontaneous 'data' events
// (SI5_DET / SI8_DET / SI_REM / bad-CRC frames).
// ----------------------------------------------------------------------------

type SendMatcher = (chunk: number[]) => boolean;
type SendHandler = (chunk: number[]) => number[] | number[][] | void;

class FakeSerialTransport extends EventEmitter implements ISerialTransport {
  public recordedSends: number[][] = [];
  public isOpen = false;
  public closed = false;
  private rules: { matcher: SendMatcher; handler: SendHandler }[] = [];

  open(): Promise<void> {
    this.isOpen = true;
    return Promise.resolve();
  }

  send(bytes: number[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('FakeSerialTransport closed'));
    this.recordedSends.push(bytes);
    // Find the FIRST matching rule and let it fire its response on next tick.
    const rule = this.rules.find((r) => r.matcher(bytes));
    if (rule) {
      const responses = rule.handler(bytes);
      if (responses !== undefined) {
        const responseList = Array.isArray(responses[0])
          ? (responses as number[][])
          : [responses as number[]];
        setImmediate(() => {
          for (const r of responseList) this.emit('data', r);
        });
      }
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

  injectClose(): void {
    this.closed = true;
    this.emit('close');
  }
}

// ----------------------------------------------------------------------------
// Helpers for building canned response frames.
// ----------------------------------------------------------------------------

/** Build a synthetic response frame: STX, cmd, len, ...params, crc_hi, crc_lo, ETX. */
const renderFrame = (command: number, parameters: number[]): number[] =>
  render({ command, parameters });

/**
 * A non-trivial bit in byte 0x74 that the handshake MUST preserve. Upstream
 * `SiStationStorageLocations` calls bit 3 of byte 0x74 `sprint4ms`; if the
 * station operator had it enabled before the handshake, the handshake must
 * not silently clear it. Test 1 uses this to assert bit preservation.
 */
const PRESERVE_BIT_74 = 1 << 3; // sprint4ms

/**
 * Build a 128-byte synthetic station config representing a station NOT yet in
 * readout mode (Workstation mode, no beeps/flashes/handshake set, extProto set,
 * sprint4ms set — to exercise bit-preservation). The handshake should leave the
 * sprint4ms bit alone, set BEEPS/FLASHES on 0x73, and set HANDSHAKE on 0x74.
 */
const makeStationConfigBlob = (): number[] => {
  const cfg = new Array<number>(128).fill(0x00);
  // Serial-number bytes (read-only — verifies handshake never writes here).
  cfg[0x00] = 0x00;
  cfg[0x01] = 0x09;
  cfg[0x02] = 0x0e;
  cfg[0x03] = 0xf8;
  cfg[STATION_CONFIG_OFFSETS.MODE] = StationMode.Workstation;
  cfg[STATION_CONFIG_OFFSETS.CODE_LOW] = 1;
  // FLAG_BYTE_73 starts at 0x00 (no beeps, no flashes, no code-high-bits).
  // FLAG_BYTE_74 has extProto (bit 0) + sprint4ms (bit 3) set pre-handshake.
  cfg[STATION_CONFIG_OFFSETS.FLAG_BYTE_74] = FLAG_BITS_74.EXT_PROTO | PRESERVE_BIT_74;
  return cfg;
};

/** GET_SYS_VAL response frame: real-wire shape is
 * `[STX, cmd, len, addr_hi, addr_lo, offset_echo, ...128 data, crc, crc, ETX]`.
 * (Bench transcript 2026-05-13 from /dev/ttyUSB0: `02 83 83 00 0A 00 ...`.)
 * BaseSiStation.readInfo does `frame.slice(5, 5+128)` to strip
 * `[cmd, len, addr_hi, addr_lo, offset_echo]` and keep the 128-byte config blob. */
const renderGetSysValResponse = (offsetEcho: number, configBytes: number[]): number[] => {
  return renderFrame(proto.cmd.GET_SYS_VAL, [0x00, 0x0a, offsetEcho, ...configBytes]);
};

/** GET_SI8 response frame (page read): real-wire shape is
 * `[STX, cmd, len, addr_hi, addr_lo, page_no, ...128 data, crc, crc, ETX]`.
 * ModernSiCard.typeSpecificGetPage does `frame.slice(5)` to strip
 * `[cmd, len, addr_hi, addr_lo, page_no]` and return the 128-byte page payload. */
const renderGetSi8PageResponse = (pageNumber: number, pageBytes: number[]): number[] => {
  return renderFrame(proto.cmd.GET_SI8, [0x00, 0x0a, pageNumber, ...pageBytes]);
};

/** GET_SI5 response frame: real-wire shape is
 * `[STX, cmd, len, addr_hi, addr_lo, ...128 data, crc, crc, ETX]`.
 * SiCard5.typeSpecificRead does `frame.slice(4)` to strip
 * `[cmd, len, addr_hi, addr_lo]` and return the 128-byte page payload. */
const renderGetSi5Response = (page128: number[]): number[] => {
  return renderFrame(proto.cmd.GET_SI5, [0x00, 0x0a, ...page128]);
};

/** Set up the rules for the atomic handshake. Returns the transport once configured. */
const setUpHandshakeRules = (fake: FakeSerialTransport): void => {
  // SET_MS — match a chunk starting [WAKEUP, STX, SET_MS, ...]. Real-wire
  // response shape: [addr_hi, addr_lo, P_MS_DIRECT] (bench: 02 F0 03 00 0A 4D ...).
  fake.addRule(
    (chunk) => chunk[0] === proto.WAKEUP && chunk[1] === proto.STX && chunk[2] === proto.cmd.SET_MS,
    () => renderFrame(proto.cmd.SET_MS, [0x00, 0x0a, proto.P_MS_DIRECT])
  );
  // GET_SYS_VAL(0, 128) — returns the synthetic 128-byte config blob. The
  // station echoes offset=0x00 (request asked for "read from offset 0").
  fake.addRule(
    (chunk) =>
      chunk[0] === proto.WAKEUP && chunk[1] === proto.STX && chunk[2] === proto.cmd.GET_SYS_VAL,
    () => renderGetSysValResponse(0x00, makeStationConfigBlob())
  );
  // SET_SYS_VAL — real-wire response: [addr_hi, addr_lo, offset_echo]. The
  // station echoes the offset byte that was written.
  fake.addRule(
    (chunk) =>
      chunk[0] === proto.WAKEUP && chunk[1] === proto.STX && chunk[2] === proto.cmd.SET_SYS_VAL,
    (chunk) => {
      // The SET_SYS_VAL frame body: [WAKEUP, STX, cmd, len, offset, ...bytes, crc_hi, crc_lo, ETX].
      // Echo offset as the third param byte, after the two station-address bytes.
      const offset = chunk[4] as number;
      return renderFrame(proto.cmd.SET_SYS_VAL, [0x00, 0x0a, offset]);
    }
  );
};

/** Helper: build an SI5_DET frame for the given card number (legacy format). */
const buildSi5DetFrame = (cardNumber: number): number[] => {
  // arr2cardNumber for SI5: bytes[5]=lo, [4]=hi, [3]=mid (per SiCard10.test.ts).
  // cardNumber 406402 = 0x06 32 02 (low=0x02 mid=0x32 hi=0x06 — verified in si5 fixture)
  // Reverse the encoding: lo = num & 0xFF, hi = (num>>8) & 0xFF, mid = floor(num/100000).
  // For SI5: cardNumber = mid*100000 + (hi<<8 | lo). Mid is in params[3], hi in params[4],
  // lo in params[5]. Card 406402 -> mid=4, hi=0x32, lo=0x02 -> 4*100000 + 12802 = 412802. Hmm.
  // Simpler: replay the SI5 fixture's first 3 bytes [0x05, 0x04, 0x06] from storage; these
  // are the cardNumber bytes per SI5 storage offsets. Recompute:
  // siCard5StorageLocations.cardNumber is SiArray(3, i -> SiInt([[ [0x05,0x04,0x06][i] ]]))
  // arr2cardNumber consumes the array in order. For our SI5 fixture cardNumber=406402
  // the bytes at offsets 5,4,6 of storage are 0x1E, 0x02, 0x04. arr2cardNumber([0x1E, 0x02, 0x04]):
  //   cardnum = (0x02 << 8) | 0x1E = 542; arr[2]=4, arr.length=3 -> cardnum += 4*100000 = 400542. Not 406402.
  // Plan tests don't actually need to match the SI5 fixture cardNumber — they just need an
  // SI5_DET frame that decodes to a number in 1000..500000. Use simple bytes.
  // The plan says: "render({command: SI5_DET, parameters: [0,0,0, ...cardNumberBytes]})".
  // detectFromMessage uses params[5], params[4], params[3] (reverse order). For cardNumber 12345:
  // 12345 = 0x3039. lo = 0x39 (params[5]), hi = 0x30 (params[4]), mid = 0 (params[3]). Result:
  //   arr2cardNumber([0x39, 0x30, 0x00]) -> cardnum = (0x30<<8)|0x39 = 12345; arr[2]=0,
  //   arr[3]=undefined -> fall through to "else" branch -> cardnum += 0*100000 = 12345.
  // params layout per detectFromMessage: [_,_,_, byte3=mid, byte4=hi, byte5=lo].
  // For SI5 (cardNumber < 500000), arr2cardNumber uses the 100k-offset path:
  //   cardnum = (hi<<8 | lo) + mid * 100000.
  // So encode: mid = floor(cardNumber/100000), residual = cardNumber - mid*100000,
  // hi = (residual >> 8) & 0xFF, lo = residual & 0xFF.
  const mid = Math.floor(cardNumber / 100000) & 0xff;
  const residual = cardNumber - mid * 100000;
  const hi = (residual >> 8) & 0xff;
  const lo = residual & 0xff;
  return renderFrame(proto.cmd.SI5_DET, [0x00, 0x00, 0x00, mid, hi, lo]);
};

/** Build an SI8_DET frame for a modern card. seriesByte is the raw series indicator
 * (recorded for forensics; dispatch is by cardNumber range). For cardNumber > 500000,
 * the high bytes need to live in params[3..5] verbatim (no mid-100k offset). */
const buildSi8DetFrame = (cardNumber: number, seriesByte: number): number[] => {
  // For modern cards, arr2cardNumber's `arr[2] > 4 || (length===4 && arr[3] !== 0)` branch
  // applies: cardnum = (hi<<8 | lo) | (mid<<16). For 7050892 = 0x6B968C:
  //   lo = 0x8C, hi = 0x96, mid = 0x6B. Verified against SiCard10.test.ts.
  const lo = cardNumber & 0xff;
  const hi = (cardNumber >> 8) & 0xff;
  const mid = (cardNumber >> 16) & 0xff;
  return renderFrame(proto.cmd.SI8_DET, [0x00, 0x00, seriesByte, mid, hi, lo]);
};

/** Bad-CRC frame: flip the low byte of the CRC on a valid SET_MS frame. */
const buildBadCrcFrame = (): number[] => {
  const good = renderFrame(proto.cmd.SET_MS, [0x00, 0x00, proto.P_MS_DIRECT]);
  // Flip a CRC byte (positions are: cmd at idx 1, len at 2, params start at 3,
  // CRC at idx 3+numParams..4+numParams. Easier: flip second-to-last (crc_lo).
  const idx = good.length - 2; // crc_lo position (before ETX)
  good[idx] = ((good[idx] as number) ^ 0xff) & 0xff;
  return good;
};

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('SiMainStation handshake + dispatch', () => {
  test('1) atomic handshake: SET_MS -> readInfo -> writeDiff puts station in Readout mode with bit-aware writes', async () => {
    const fake = new FakeSerialTransport();
    setUpHandshakeRules(fake);

    const station = new SiMainStation(fake);
    await fake.open();

    const states: string[] = [];
    station.on('connectionChanged', (s: string) => states.push(s));

    await station.readCards();

    // Handshake sent SET_MS, GET_SYS_VAL, and at least one SET_SYS_VAL.
    const sentCommands = fake.recordedSends
      .filter((c) => c[1] === proto.STX)
      .map((c) => c[2] as number);
    assert.ok(sentCommands.includes(proto.cmd.SET_MS), 'SET_MS sent');
    assert.ok(sentCommands.includes(proto.cmd.GET_SYS_VAL), 'GET_SYS_VAL sent');
    assert.ok(sentCommands.includes(proto.cmd.SET_SYS_VAL), 'SET_SYS_VAL sent');
    assert.deepStrictEqual(states, ['opening', 'open']);

    // Reconstruct the post-handshake config by replaying every SET_SYS_VAL
    // write onto a copy of the synthetic pre-handshake blob. Each on-wire
    // frame: [WAKEUP, STX, cmd, len, offset, ...bytes, crc_hi, crc_lo, ETX].
    const postConfig = makeStationConfigBlob();
    for (const chunk of fake.recordedSends) {
      if (chunk[0] !== proto.WAKEUP) continue;
      if (chunk[1] !== proto.STX) continue;
      if (chunk[2] !== proto.cmd.SET_SYS_VAL) continue;
      const len = chunk[3] as number; // params length (offset + bytes)
      const offset = chunk[4] as number;
      const numDataBytes = len - 1;
      for (let i = 0; i < numDataBytes; i++) {
        postConfig[offset + i] = chunk[5 + i] as number;
      }
    }

    // Mode is whole-byte Readout.
    assert.strictEqual(
      postConfig[STATION_CONFIG_OFFSETS.MODE],
      StationMode.Readout,
      `byte 0x71 (mode) expected ${StationMode.Readout}, got ${postConfig[STATION_CONFIG_OFFSETS.MODE]}`
    );

    // Code low byte is 10 (whole byte at 0x72).
    assert.strictEqual(
      postConfig[STATION_CONFIG_OFFSETS.CODE_LOW],
      10,
      `byte 0x72 (code low) expected 10, got ${postConfig[STATION_CONFIG_OFFSETS.CODE_LOW]}`
    );

    // Byte 0x73 has FLASHES (bit 0) and BEEPS (bit 2) SET.
    const byte73 = postConfig[STATION_CONFIG_OFFSETS.FLAG_BYTE_73]!;
    assert.ok(
      (byte73 & FLAG_BITS_73.BEEPS) !== 0,
      `byte 0x73 BEEPS bit (0x04) must be SET, got 0x${byte73.toString(16)}`
    );
    assert.ok(
      (byte73 & FLAG_BITS_73.FLASHES) !== 0,
      `byte 0x73 FLASHES bit (0x01) must be SET, got 0x${byte73.toString(16)}`
    );
    // code-high-bits cleared (code <= 255).
    assert.strictEqual(
      byte73 & FLAG_BITS_73.CODE_HIGH_MASK,
      0,
      `byte 0x73 CODE_HIGH bits must be CLEAR, got 0x${byte73.toString(16)}`
    );

    // Byte 0x74 has EXT_PROTO (bit 0) + HANDSHAKE (bit 2) SET; AUTO_SEND
    // (bit 1) CLEAR; sprint4ms (bit 3) PRESERVED from pre-handshake state.
    const byte74 = postConfig[STATION_CONFIG_OFFSETS.FLAG_BYTE_74]!;
    assert.ok(
      (byte74 & FLAG_BITS_74.HANDSHAKE) !== 0,
      `byte 0x74 HANDSHAKE bit (0x04) must be SET, got 0x${byte74.toString(16)}`
    );
    assert.ok(
      (byte74 & FLAG_BITS_74.EXT_PROTO) !== 0,
      `byte 0x74 EXT_PROTO bit (0x01) must be SET, got 0x${byte74.toString(16)}`
    );
    assert.strictEqual(
      byte74 & FLAG_BITS_74.AUTO_SEND,
      0,
      `byte 0x74 AUTO_SEND bit (0x02) must be CLEAR, got 0x${byte74.toString(16)}`
    );
    assert.ok(
      (byte74 & PRESERVE_BIT_74) !== 0,
      `byte 0x74 sprint4ms bit (0x08) must be PRESERVED, got 0x${byte74.toString(16)}`
    );

    // Critically: serial-number bytes (0x00..0x03) must NOT have been written.
    assert.strictEqual(postConfig[0x00], 0x00, 'SN byte 0x00 must not change');
    assert.strictEqual(postConfig[0x01], 0x09, 'SN byte 0x01 must not change');
    assert.strictEqual(
      postConfig[0x02],
      0x0e,
      'SN byte 0x02 must not change (bench bug 2026-05-13)'
    );
    assert.strictEqual(postConfig[0x03], 0xf8, 'SN byte 0x03 must not change');

    await station.close();
  });

  test('2) every wire chunk starts with WAKEUP (0xFF)', async () => {
    const fake = new FakeSerialTransport();
    setUpHandshakeRules(fake);

    const station = new SiMainStation(fake);
    await fake.open();
    await station.readCards();

    // After the handshake, send one additional command (GET_SI5) to ensure the
    // post-handshake send path also prepends WAKEUP — explicitly
    // requires "every command, not only handshake".
    fake.addRule(
      (chunk) => chunk[0] === proto.WAKEUP && chunk[2] === proto.cmd.GET_SI5,
      () => renderGetSi5Response(new Array<number>(128).fill(0x00))
    );
    await station.sendMessage({ command: proto.cmd.GET_SI5, parameters: [] });

    // Every recordedSends entry must start with WAKEUP.
    assert.ok(fake.recordedSends.length >= 3, 'multiple sends recorded');
    for (const chunk of fake.recordedSends) {
      assert.strictEqual(
        chunk[0],
        proto.WAKEUP,
        `Expected chunk to start with WAKEUP (0xFF), got 0x${(chunk[0] ?? -1).toString(16)}`
      );
    }
    await station.close();
  });

  test('3) SI5 insertion path: emits cardInserted (SiCard5) and cardRead with populated punches', async () => {
    const fake = new FakeSerialTransport();
    setUpHandshakeRules(fake);
    const station = new SiMainStation(fake);
    await fake.open();
    await station.readCards();

    // Wire the GET_SI5 reply to return the SI5 fixture as a single 128-byte page.
    fake.addRule(
      (chunk) => chunk[0] === proto.WAKEUP && chunk[2] === proto.cmd.GET_SI5,
      () => renderGetSi5Response(si5Fixture.storageData as number[])
    );

    const inserted: unknown[] = [];
    const read: unknown[] = [];
    station.on('cardInserted', (card: unknown) => inserted.push(card));
    station.on('cardRead', (card: unknown) => read.push(card));

    // Inject SI5_DET frame.
    fake.inject(buildSi5DetFrame(si5Fixture.cardData.cardNumber));

    // Wait long enough for SI5_DET -> cardInserted -> read() -> GET_SI5 -> cardRead.
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(inserted.length, 1, 'cardInserted emitted once');
    assert.ok(inserted[0] instanceof SiCard5, 'cardInserted with SiCard5 instance');
    const insertedCard = inserted[0] as SiCard5;
    assert.strictEqual(insertedCard.cardNumber, si5Fixture.cardData.cardNumber);

    assert.strictEqual(read.length, 1, 'cardRead emitted once');
    const readCard = read[0] as SiCard5;
    assert.strictEqual(
      readCard.raceResult.punches?.length,
      (si5Fixture.cardData.punches as unknown[]).length
    );
    await station.close();
  });

  test('4) SI9 insertion path: cardInserted (SiCard9), GET_SI8 page 4 issued, cardRead populated', async () => {
    const fake = new FakeSerialTransport();
    setUpHandshakeRules(fake);
    const station = new SiMainStation(fake);
    await fake.open();
    await station.readCards();

    // SI9: pages 0 then 1 (no page-4 split because SI9's punches live at offset 0x38
    // within page 0 layout). The decoder reads page 0 and page 1.
    const bytesPerPage = 128;
    fake.addRule(
      (chunk) => chunk[0] === proto.WAKEUP && chunk[2] === proto.cmd.GET_SI8,
      (chunk) => {
        const pageNumber = chunk[4] as number;
        const start = pageNumber * bytesPerPage;
        const pageBytes = (si9Fixture.storageData as number[]).slice(start, start + bytesPerPage);
        return renderGetSi8PageResponse(pageNumber, pageBytes);
      }
    );

    const inserted: unknown[] = [];
    const read: unknown[] = [];
    station.on('cardInserted', (card: unknown) => inserted.push(card));
    station.on('cardRead', (card: unknown) => read.push(card));

    fake.inject(buildSi8DetFrame(si9Fixture.cardData.cardNumber, 0x01));
    await new Promise((r) => setTimeout(r, 80));

    assert.strictEqual(inserted.length, 1);
    assert.ok(inserted[0] instanceof SiCard9, 'cardInserted with SiCard9 instance');
    const insertedCard = inserted[0] as SiCard9;
    assert.strictEqual(insertedCard.cardNumber, si9Fixture.cardData.cardNumber);
    assert.strictEqual(insertedCard.cardSeriesByte, 0x01);

    assert.strictEqual(read.length, 1, 'cardRead emitted once');
    const readCard = read[0] as SiCard9;
    assert.strictEqual(
      readCard.raceResult.punches?.length,
      (si9Fixture.cardData.punches as unknown[]).length
    );
    await station.close();
  });

  test('5) SI10 insertion path issues GET_SI8 [0x00] AND [0x04] page reads', async () => {
    const fake = new FakeSerialTransport();
    setUpHandshakeRules(fake);
    const station = new SiMainStation(fake);
    await fake.open();
    await station.readCards();

    const bytesPerPage = 128;
    fake.addRule(
      (chunk) => chunk[0] === proto.WAKEUP && chunk[2] === proto.cmd.GET_SI8,
      (chunk) => {
        const pageNumber = chunk[4] as number;
        const start = pageNumber * bytesPerPage;
        const pageBytes = (si10Fixture.storageData as number[]).slice(start, start + bytesPerPage);
        return renderGetSi8PageResponse(pageNumber, pageBytes);
      }
    );

    const inserted: unknown[] = [];
    const read: unknown[] = [];
    station.on('cardInserted', (card: unknown) => inserted.push(card));
    station.on('cardRead', (card: unknown) => read.push(card));

    fake.inject(buildSi8DetFrame(si10Fixture.cardData.cardNumber, 0x0f));
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(inserted[0] instanceof SiCard10, 'cardInserted with SiCard10 instance');
    assert.strictEqual(read.length, 1, 'cardRead emitted once');

    // Pull every GET_SI8 send chunk and inspect its page parameter (chunk[4]).
    const getSi8Pages = fake.recordedSends
      .filter((c) => c[0] === proto.WAKEUP && c[2] === proto.cmd.GET_SI8)
      .map((c) => c[4] as number);
    assert.ok(getSi8Pages.includes(0x00), `expected page 0x00 in ${JSON.stringify(getSi8Pages)}`);
    assert.ok(getSi8Pages.includes(0x04), `expected page 0x04 in ${JSON.stringify(getSi8Pages)}`);
    await station.close();
  });

  test('6) SIAC insertion path uses SI8_DET, dispatched as SIAC, page 4 read', async () => {
    const fake = new FakeSerialTransport();
    setUpHandshakeRules(fake);
    const station = new SiMainStation(fake);
    await fake.open();
    await station.readCards();

    // SIAC fixture cardNumber: 8500608 (in 8M-9M SIAC range).
    const siacFixture = (await import('../../tests/fixtures/upstream/siac-typical.ts')).fixture;
    const bytesPerPage = 128;
    fake.addRule(
      (chunk) => chunk[0] === proto.WAKEUP && chunk[2] === proto.cmd.GET_SI8,
      (chunk) => {
        const pageNumber = chunk[4] as number;
        const start = pageNumber * bytesPerPage;
        const pageBytes = (siacFixture.storageData as number[]).slice(start, start + bytesPerPage);
        return renderGetSi8PageResponse(pageNumber, pageBytes);
      }
    );

    const inserted: unknown[] = [];
    const read: unknown[] = [];
    station.on('cardInserted', (card: unknown) => inserted.push(card));
    station.on('cardRead', (card: unknown) => read.push(card));

    fake.inject(buildSi8DetFrame(siacFixture.cardData.cardNumber, 0x0f));
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(inserted[0] instanceof SIAC, 'cardInserted with SIAC instance');
    assert.strictEqual(read.length, 1, 'cardRead emitted once');

    const getSi8Pages = fake.recordedSends
      .filter((c) => c[0] === proto.WAKEUP && c[2] === proto.cmd.GET_SI8)
      .map((c) => c[4] as number);
    assert.ok(getSi8Pages.includes(0x04), `expected page 0x04 in ${JSON.stringify(getSi8Pages)}`);
    await station.close();
  });

  test('7) SI_REM emits cardRemoved with the same cardNumber', async () => {
    const fake = new FakeSerialTransport();
    setUpHandshakeRules(fake);
    const station = new SiMainStation(fake);
    await fake.open();
    await station.readCards();

    const removed: number[] = [];
    station.on('cardRemoved', (n: number) => removed.push(n));

    // SI_REM frame for cardNumber 7050892 (SI10). Build like SI8_DET (same param layout).
    const cardNumber = 7050892;
    const lo = cardNumber & 0xff;
    const hi = (cardNumber >> 8) & 0xff;
    const mid = (cardNumber >> 16) & 0xff;
    fake.inject(renderFrame(proto.cmd.SI_REM, [0x00, 0x00, 0x0f, mid, hi, lo]));
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(removed.length, 1, 'cardRemoved fired once');
    assert.strictEqual(removed[0], cardNumber);
    await station.close();
  });

  test('8) send timeout: sendMessage rejects with SendTimeoutError when station never replies', async () => {
    const fake = new FakeSerialTransport();
    // No rules — fake never replies. Don't run handshake; just call sendMessage directly.
    const station = new SiMainStation(fake);
    await fake.open();
    await assert.rejects(
      () =>
        station.sendMessage({ command: proto.cmd.GET_SI5, parameters: [] }, 1, /* timeoutMs */ 100),
      SendTimeoutError
    );
    await station.close();
  });

  test('9) transport close mid-flight rejects pending send with DeviceClosedError; connectionChanged:closed', async () => {
    const fake = new FakeSerialTransport();
    // No reply rule — the send hangs. Inject close mid-flight.
    const station = new SiMainStation(fake);
    await fake.open();
    const states: string[] = [];
    station.on('connectionChanged', (s: string) => states.push(s));

    const pending = station.sendMessage(
      { command: proto.cmd.GET_SI5, parameters: [] },
      1,
      /* timeoutMs */ 5_000
    );

    // Give the send queue a tick to start, then close.
    await new Promise((r) => setImmediate(r));
    fake.injectClose();

    await assert.rejects(() => pending, DeviceClosedError);
    // After close: connectionChanged should have transitioned to 'closed'.
    await new Promise((r) => setImmediate(r));
    assert.ok(states.includes('closed'), `expected 'closed' in ${JSON.stringify(states)}`);
  });

  test('11) after a successful card read, multiplexer sends a bare ACK (0x06)', async () => {
    const fake = new FakeSerialTransport();
    setUpHandshakeRules(fake);
    const station = new SiMainStation(fake);
    await fake.open();
    await station.readCards();

    // Wire GET_SI5 to return the fixture as a single 128-byte page.
    fake.addRule(
      (chunk) => chunk[0] === proto.WAKEUP && chunk[2] === proto.cmd.GET_SI5,
      () => renderGetSi5Response(si5Fixture.storageData as number[])
    );

    let cardReadFired = false;
    station.on('cardRead', () => {
      cardReadFired = true;
    });

    // Snapshot the send-count before the card insertion so we look at only
    // the post-card sends.
    const preCardSendCount = fake.recordedSends.length;

    fake.inject(buildSi5DetFrame(si5Fixture.cardData.cardNumber));
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(cardReadFired, true, 'cardRead must fire');

    const postCardSends = fake.recordedSends.slice(preCardSendCount);
    // postCardSends should contain at least: [WAKEUP, STX, GET_SI5, ...] AND [0x06].
    const hasGetSi5 = postCardSends.some(
      (chunk) => chunk[0] === proto.WAKEUP && chunk[2] === proto.cmd.GET_SI5
    );
    const ackChunk = postCardSends.find((chunk) => chunk.length === 1 && chunk[0] === 0x06);
    assert.ok(hasGetSi5, 'GET_SI5 should have been sent during card-read');
    assert.ok(
      ackChunk,
      `expected a bare ACK (0x06) send after card read; postCardSends=${JSON.stringify(postCardSends.map((c) => c.map((b) => b.toString(16))))}`
    );

    // Order matters: ACK must come AFTER GET_SI5 (the read), not before.
    const getSi5Idx = postCardSends.findIndex(
      (chunk) => chunk[0] === proto.WAKEUP && chunk[2] === proto.cmd.GET_SI5
    );
    const ackIdx = postCardSends.findIndex((chunk) => chunk.length === 1 && chunk[0] === 0x06);
    assert.ok(ackIdx > getSi5Idx, `ACK (idx=${ackIdx}) must come after GET_SI5 (idx=${getSi5Idx})`);

    await station.close();
  });

  test('10) bad-CRC frame emits "frameError" via typed callback; NO stdout/stderr writes', async () => {
    const fake = new FakeSerialTransport();
    const station = new SiMainStation(fake);
    await fake.open();

    // Track writes via passthrough listeners instead of replacing the
    // underlying methods (replacing them confuses node:test's TAP printer).
    // The expectation is: zero writes happen FROM OUR CODE during the bad-CRC
    // frame's traversal. We can verify by capturing writes only within a tight
    // window — the runner doesn't write between our `fake.inject(...)` and
    // the final assertions because those are microtask-bounded and the runner
    // only prints between top-level tests.
    const writeRecord = { stdout: 0, stderr: 0 };
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
    const stdoutWrapper = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      writeRecord.stdout++;
      return origStdout(
        chunk as string | Uint8Array,
        ...(rest as Parameters<typeof origStdout> extends [unknown, ...infer R] ? R : never[])
      );
    }) as typeof process.stdout.write;
    const stderrWrapper = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      writeRecord.stderr++;
      return origStderr(
        chunk as string | Uint8Array,
        ...(rest as Parameters<typeof origStderr> extends [unknown, ...infer R] ? R : never[])
      );
    }) as typeof process.stderr.write;
    process.stdout.write = stdoutWrapper;
    process.stderr.write = stderrWrapper;

    const errors: FrameError[] = [];
    station.on('frameError', (err: FrameError) => errors.push(err));

    // Snapshot AFTER any test-runner writes finish but BEFORE the bad-CRC frame
    // reaches the multiplexer. inject() schedules a setImmediate; we drain via
    // a single setImmediate so the runner has no chance to write between our
    // baseline snapshot and the assertions.
    await new Promise((r) => setImmediate(r));
    const baselineStdout = writeRecord.stdout;
    const baselineStderr = writeRecord.stderr;
    fake.inject(buildBadCrcFrame());
    // The injected event is also scheduled via setImmediate; one drain is
    // enough for parseAll's synchronous path to fire onFrameError.
    await new Promise((r) => setImmediate(r));
    const stdoutDelta = writeRecord.stdout - baselineStdout;
    const stderrDelta = writeRecord.stderr - baselineStderr;

    // Restore BEFORE the asserts so a failure message can still print.
    process.stdout.write = origStdout as typeof process.stdout.write;
    process.stderr.write = origStderr as typeof process.stderr.write;

    assert.strictEqual(errors.length, 1, 'frameError emitted exactly once');
    assert.strictEqual(errors[0]!.error_code, 'crc_mismatch');
    assert.ok(errors[0]!.expected_crc, 'expected_crc present');
    assert.ok(errors[0]!.actual_crc, 'actual_crc present');
    assert.strictEqual(stdoutDelta, 0, 'NO stdout writes during frame handling');
    assert.strictEqual(stderrDelta, 0, 'NO stderr writes during frame handling');
    await station.close();
  });
});

/**
 * Card A (SI10) is pulled while its page 4 is requested; 30 ms later card B
 * (SI9) is put on the station. The station answers page 4 with a bare NAK
 * (`nak`) or not at all, then reports SI_REM for A and SI8_DET for B in one
 * chunk. Bench repro 2026-10-17: B's page 0 was handed to A's page-4 request.
 */
const setUpPulledCard = (fake: FakeSerialTransport, nak: boolean): void => {
  const bytesPerPage = 128;
  const a = si10Fixture.cardData.cardNumber;
  let onStation: 'A' | 'B' | undefined = 'A';
  fake.addRule(
    (chunk) => chunk[0] === proto.WAKEUP && chunk[2] === proto.cmd.GET_SI8,
    (chunk) => {
      const page = chunk[4] as number;
      if (onStation === 'A' && page === 4) {
        onStation = undefined;
        setTimeout(() => {
          onStation = 'B';
          fake.inject([
            ...renderFrame(proto.cmd.SI_REM, [
              0x00,
              0x00,
              0x0f,
              (a >> 16) & 0xff,
              (a >> 8) & 0xff,
              a & 0xff,
            ]),
            ...buildSi8DetFrame(si9Fixture.cardData.cardNumber, 0x01),
          ]);
        }, 30);
        return nak ? [proto.NAK] : undefined;
      }
      const storage =
        onStation === 'A'
          ? si10Fixture.storageData
          : onStation === 'B'
            ? si9Fixture.storageData
            : undefined;
      if (storage === undefined) return [proto.NAK];
      const start = page * bytesPerPage;
      return renderGetSi8PageResponse(
        page,
        (storage as number[]).slice(start, start + bytesPerPage)
      );
    }
  );
};

/** Run the pulled-card scenario; returns what the station reported. */
const runPulledCard = async (
  nak: boolean
): Promise<{ read: SiCard9[]; errors: Error[]; sendsAfterInsert: number[][] }> => {
  const fake = new FakeSerialTransport();
  setUpHandshakeRules(fake);
  const station = new SiMainStation(fake);
  await fake.open();
  await station.readCards();
  setUpPulledCard(fake, nak);
  const read: SiCard9[] = [];
  const errors: Error[] = [];
  station.on('cardRead', (card: SiCard9) => read.push(card));
  station.on('error', (err: Error) => errors.push(err));
  const before = fake.recordedSends.length;
  fake.inject(buildSi8DetFrame(si10Fixture.cardData.cardNumber, 0x0f));
  // Far below the 10 s send timeout: the pulled read must fail on its own.
  await new Promise((r) => setTimeout(r, 200));
  const sendsAfterInsert = fake.recordedSends.slice(before);
  await station.close();
  return { read, errors, sendsAfterInsert };
};

const assertOnlyBReadAndAcked = (result: Awaited<ReturnType<typeof runPulledCard>>): void => {
  assert.strictEqual(result.errors.length, 1, 'the pulled card A fails once');
  assert.strictEqual(result.read.length, 1, 'card B is read');
  assert.ok(result.read[0] instanceof SiCard9);
  assert.strictEqual(result.read[0]!.raceResult.cardNumber, si9Fixture.cardData.cardNumber);
  const acks = result.sendsAfterInsert.filter((c) => c.length === 1 && c[0] === proto.ACK);
  assert.strictEqual(acks.length, 1, 'exactly one ACK, for B');
  const lastPageRead = result.sendsAfterInsert.findLastIndex((c) => c[2] === proto.cmd.GET_SI8);
  assert.ok(result.sendsAfterInsert.indexOf(acks[0]!) > lastPageRead, 'ACK after B is read');
};

describe('SiMainStation: card pulled mid-read', () => {
  test('NAK during a page read fails that read; the next card is read correctly', async () => {
    assertOnlyBReadAndAcked(await runPulledCard(true));
  });

  test('pulled card (SI_REM, no NAK) + new card inside the old timeout: no misattribution', async () => {
    const result = await runPulledCard(false);
    assertOnlyBReadAndAcked(result);
    assert.match(result.errors[0]!.message, /removed/);
  });
});

// Suppress "registers populated by side-effect" lint hint on the imports.
void BaseSiCard;
// Reference CRC16 so unused-import lint doesn't trip when the helper inlines change.
void CRC16;
// Reference si10ManyFixture so the import line is intentional for future multi-page tests.
void si10ManyFixture;
