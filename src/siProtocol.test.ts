// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/siProtocol.test.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications: rewritten for `node:test` + `node:assert/strict`
// (upstream uses jest), 10 CRC frozen vectors, and the bad-CRC test
// asserts the structured FrameError callback instead
// of upstream's stdout-warn intercept assertion.
// See NOTICE.md for cumulative attribution.

import { describe, test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CRC16, parse, parseAll, render, type FrameError } from './siProtocol.ts';
import { proto } from './constants.ts';

// ----------------------------------------------------------------------------
// CRC16 — 10 frozen vectors.
// These define the canonical SportIdent CRC; every later wave depends on them.
// ----------------------------------------------------------------------------

describe('CRC16 frozen vectors', () => {
  test('CRC16 empty input -> [0x00, 0x00]', () => {
    assert.deepStrictEqual(CRC16([]), [0x00, 0x00]);
  });

  test('CRC16 1-byte short-circuit (0x01)', () => {
    assert.deepStrictEqual(CRC16([0x01]), [0x01, 0x00]);
  });

  test('CRC16 1-byte short-circuit (0x12)', () => {
    assert.deepStrictEqual(CRC16([0x12]), [0x12, 0x00]);
  });

  test('CRC16 1-byte short-circuit (0xFF)', () => {
    assert.deepStrictEqual(CRC16([0xff]), [0xff, 0x00]);
  });

  test('CRC16 2-byte short-circuit identity (0x01 0x02)', () => {
    assert.deepStrictEqual(CRC16([0x01, 0x02]), [0x01, 0x02]);
  });

  test('CRC16 2-byte short-circuit identity (0x12 0x34)', () => {
    assert.deepStrictEqual(CRC16([0x12, 0x34]), [0x12, 0x34]);
  });

  test('CRC16 3-byte one polynomial iteration', () => {
    assert.deepStrictEqual(CRC16([0x12, 0x34, 0x56]), [0xba, 0xbb]);
  });

  test('CRC16 3-byte sensitivity (byte-2 flip changes output)', () => {
    // Flips bit in middle byte (0x34 -> 0x32); CRC must respond.
    assert.deepStrictEqual(CRC16([0x12, 0x32, 0x56]), [0xba, 0xaf]);
  });

  test('CRC16 4-byte one polynomial iteration', () => {
    assert.deepStrictEqual(CRC16([0x12, 0x34, 0x56, 0x78]), [0x1e, 0x83]);
  });

  test('CRC16 4-byte sensitivity (byte-2 flip changes output)', () => {
    assert.deepStrictEqual(CRC16([0x12, 0x32, 0x56, 0x78]), [0x1e, 0xfb]);
  });
});

// ----------------------------------------------------------------------------
// parse / parseAll / render — single-frame primitives.
// ----------------------------------------------------------------------------

describe('parse: bare single-byte modes', () => {
  test('parse([ACK]) -> mode=ACK, no remainder', () => {
    const { message, remainder } = parse([proto.ACK]);
    assert.deepStrictEqual(message, { mode: proto.ACK });
    assert.deepStrictEqual(remainder, []);
  });

  test('parse([NAK]) -> mode=NAK, no remainder', () => {
    const { message, remainder } = parse([proto.NAK]);
    assert.deepStrictEqual(message, { mode: proto.NAK });
    assert.deepStrictEqual(remainder, []);
  });

  test('parse([WAKEUP]) -> mode=WAKEUP, no remainder', () => {
    const { message, remainder } = parse([proto.WAKEUP]);
    assert.deepStrictEqual(message, { mode: proto.WAKEUP });
    assert.deepStrictEqual(remainder, []);
  });
});

describe('render + parse round-trip', () => {
  test('GET_SI5 with no parameters round-trips', () => {
    const message = { command: proto.cmd.GET_SI5, parameters: [] };
    const bytes = render(message);
    // [STX, 0xB1, 0x00, crc_hi, crc_lo, ETX] -> 6 bytes
    assert.strictEqual(bytes[0], proto.STX);
    assert.strictEqual(bytes[1], proto.cmd.GET_SI5);
    assert.strictEqual(bytes[2], 0x00); // LEN
    assert.strictEqual(bytes[bytes.length - 1], proto.ETX);
    assert.strictEqual(bytes.length, 6);

    const { message: parsed, remainder } = parse(bytes);
    assert.deepStrictEqual(parsed, message);
    assert.deepStrictEqual(remainder, []);
  });

  test('SET_MS(0x4D) with one parameter round-trips', () => {
    const message = {
      command: proto.cmd.SET_MS,
      parameters: [proto.P_MS_DIRECT],
    };
    const bytes = render(message);
    const { message: parsed, remainder } = parse(bytes);
    assert.deepStrictEqual(parsed, message);
    assert.deepStrictEqual(remainder, []);
  });
});

describe('parse: truncated frame returns remainder', () => {
  test('Drop last byte (ETX) -> message null, remainder = full input', () => {
    const full = render({ command: proto.cmd.SET_MS, parameters: [proto.P_MS_DIRECT] });
    const truncated = full.slice(0, full.length - 1);
    const { message, remainder } = parse(truncated);
    assert.strictEqual(message, null);
    assert.deepStrictEqual(remainder, truncated);
  });

  test('First 4 bytes only -> message null, remainder = those 4 bytes', () => {
    // [STX, F0, 01, 4D] — header without CRC/ETX.
    const half = [proto.STX, proto.cmd.SET_MS, 0x01, proto.P_MS_DIRECT];
    const { message, remainder } = parse(half);
    assert.strictEqual(message, null);
    assert.deepStrictEqual(remainder, half);
  });
});

describe('parse: bad-STX prefix is silently skipped', () => {
  test('[0x42, STX, ...frame, ETX] parses inner frame on the next parse() call', () => {
    const inner = render({ command: proto.cmd.GET_SI5, parameters: [] });
    const garbage = [0x42, ...inner];

    // First parse() drops the 0x42 garbage byte.
    const first = parse(garbage);
    assert.strictEqual(first.message, null);
    assert.deepStrictEqual(first.remainder, inner);

    // Second parse() yields the inner message.
    const second = parse(first.remainder);
    assert.deepStrictEqual(second.message, { command: proto.cmd.GET_SI5, parameters: [] });
    assert.deepStrictEqual(second.remainder, []);
  });

  test('parseAll silently skips a garbage byte and yields the inner frame', () => {
    const inner = render({ command: proto.cmd.GET_SI5, parameters: [] });
    const { messages, remainder } = parseAll([0x42, ...inner]);
    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], { command: proto.cmd.GET_SI5, parameters: [] });
    assert.deepStrictEqual(remainder, []);
  });
});

// ----------------------------------------------------------------------------
// parseAll — back-to-back frames + structured FrameError channel.
// Bad CRC must NOT write to stdout/stderr; it must invoke onFrameError.
// ----------------------------------------------------------------------------

describe('parseAll: back-to-back frames', () => {
  test('Two rendered frames concatenated -> two messages, no remainder', () => {
    const m1 = render({ command: proto.cmd.SET_MS, parameters: [proto.P_MS_DIRECT] });
    const m2 = render({ command: proto.cmd.GET_SI5, parameters: [] });
    const { messages, remainder } = parseAll([...m1, ...m2]);
    assert.strictEqual(messages.length, 2);
    assert.deepStrictEqual(messages[0], {
      command: proto.cmd.SET_MS,
      parameters: [proto.P_MS_DIRECT],
    });
    assert.deepStrictEqual(messages[1], { command: proto.cmd.GET_SI5, parameters: [] });
    assert.deepStrictEqual(remainder, []);
  });

  test('frame1 + partial frame2 -> one message, remainder = the partial bytes', () => {
    const m1 = render({ command: proto.cmd.SET_MS, parameters: [proto.P_MS_DIRECT] });
    const m2 = render({ command: proto.cmd.GET_SI5, parameters: [] });
    // Take only the first 3 bytes of m2.
    const partial = m2.slice(0, 3);
    const { messages, remainder } = parseAll([...m1, ...partial]);
    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0], {
      command: proto.cmd.SET_MS,
      parameters: [proto.P_MS_DIRECT],
    });
    assert.deepStrictEqual(remainder, partial);
  });
});

describe('parseAll: bad-CRC frame via FrameError callback', () => {
  // Build a valid SET_MS(0x4D) frame, then flip the last bit of crc_lo.
  const buildBadCrcFrame = (): {
    frame: number[];
    expectedCrc: [number, number];
    actualCrc: [number, number];
  } => {
    const good = render({ command: proto.cmd.SET_MS, parameters: [proto.P_MS_DIRECT] });
    const bad = [...good];
    // Layout: [STX, CMD, LEN, ...DATA, crc_hi, crc_lo, ETX] — flip crc_lo.
    const crcLoIdx = bad.length - 2;
    bad[crcLoIdx] = (bad[crcLoIdx] as number) ^ 0x01;
    const expectedCrc: [number, number] = [
      good[good.length - 3] as number,
      good[good.length - 2] as number,
    ];
    const actualCrc: [number, number] = [
      bad[bad.length - 3] as number,
      bad[bad.length - 2] as number,
    ];
    return { frame: bad, expectedCrc, actualCrc };
  };

  let stdoutSpy: ReturnType<typeof mock.method>;
  let stderrSpy: ReturnType<typeof mock.method>;

  beforeEach(() => {
    stdoutSpy = mock.method(process.stdout, 'write', () => true);
    stderrSpy = mock.method(process.stderr, 'write', () => true);
  });

  afterEach(() => {
    stdoutSpy.mock.restore();
    stderrSpy.mock.restore();
  });

  test('bad CRC, NO callback: silent drop, 0 messages, 0 stdout, 0 stderr writes', () => {
    const { frame } = buildBadCrcFrame();
    const { messages, remainder } = parseAll(frame);
    assert.strictEqual(messages.length, 0);
    assert.deepStrictEqual(remainder, []);
    // Critical: zero stdout / stderr writes from siProtocol.parseAll.
    assert.strictEqual(stdoutSpy.mock.callCount(), 0);
    assert.strictEqual(stderrSpy.mock.callCount(), 0);
  });

  test('bad CRC, WITH callback: callback fires once with typed FrameError payload', () => {
    const { frame, expectedCrc, actualCrc } = buildBadCrcFrame();
    const errors: FrameError[] = [];
    const { messages, remainder } = parseAll(frame, {
      onFrameError: (err) => errors.push(err),
    });

    // No messages produced from a corrupted frame.
    assert.strictEqual(messages.length, 0);
    assert.deepStrictEqual(remainder, []);

    // Exactly one structured FrameError.
    assert.strictEqual(errors.length, 1);
    const err = errors[0]!;
    assert.strictEqual(err.error_code, 'crc_mismatch');
    assert.deepStrictEqual(err.expected_crc, expectedCrc);
    assert.deepStrictEqual(err.actual_crc, actualCrc);
    assert.notDeepStrictEqual(err.expected_crc, err.actual_crc);
    assert.deepStrictEqual(err.raw_bytes, frame);
    assert.strictEqual(err.bytes_consumed, frame.length);

    // No stdout / stderr writes even with the callback path active.
    assert.strictEqual(stdoutSpy.mock.callCount(), 0);
    assert.strictEqual(stderrSpy.mock.callCount(), 0);
  });
});

describe('parseAll: a bad-CRC frame that spans whole frames', () => {
  test('noise whose fake length ends on a real ETX: the frames inside are still parsed', () => {
    const det = (n: number): number[] =>
      render({
        command: 0xe8,
        parameters: [0, 0x0a, 0x0f, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff],
      });
    // 02 EF F9 claims 249 bytes: its "ETX" is the last byte of the 21st DET.
    const bytes = [
      0x02,
      0xef,
      12 * 20 + 9,
      ...Array.from({ length: 21 }, (_, k) => det(8_000_000 + k)).flat(),
    ];
    const errors: FrameError[] = [];
    const { messages, remainder } = parseAll(bytes, { onFrameError: (e) => errors.push(e) });
    assert.strictEqual(messages.length, 21);
    assert.deepStrictEqual(
      errors.map((e) => [e.error_code, e.bytes_consumed]),
      [['crc_mismatch', 3]],
      'only the noise is dropped'
    );
    assert.deepStrictEqual(remainder, []);
  });
});
