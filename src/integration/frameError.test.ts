// Authored for lool. Not ported from upstream.
// Replacement for the Wave 0 placeholder. Implements the structured
// FrameError callback assertion (HIGH) for:
// feeding the synthetic crc-mismatch fixture into parseAll(input, {onFrameError})
// invokes the callback exactly once with error_code: 'crc_mismatch' AND yields
// zero messages. The NDJSON bridge test extends this.
// See NOTICE.md for cumulative attribution.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAll, type FrameError } from '../siProtocol.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/integration -> ../../tests/fixtures/synthetic
const fixturesDir = join(__dirname, '..', '..', 'tests', 'fixtures', 'synthetic');

const loadBytesHex = (path: string): number[] =>
  readFileSync(path, 'utf-8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '')) // strip line comments
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => parseInt(tok, 16));

test('synthetic/crc-mismatch.bytes.hex -> onFrameError fires once with crc_mismatch', () => {
  const bytes = loadBytesHex(join(fixturesDir, 'crc-mismatch.bytes.hex'));
  // Sanity check that the fixture loaded as bytes (every value in 0..255).
  assert.ok(bytes.length > 0, 'fixture is non-empty');
  assert.ok(
    bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255),
    'fixture parses to a byte array'
  );

  const errors: FrameError[] = [];
  const { messages, remainder } = parseAll(bytes, {
    onFrameError: (err) => errors.push(err),
  });

  assert.strictEqual(messages.length, 0);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0]!.error_code, 'crc_mismatch');
  // Bytes_consumed should equal the full bad-frame length (STX..ETX = 7 bytes
  // for SET_MS(0x4D) with one parameter).
  assert.strictEqual(errors[0]!.bytes_consumed, bytes.length);
  assert.deepStrictEqual(remainder, []);
});

test('synthetic/back-to-back-frames.bytes.hex -> 2 messages, 0 errors, empty remainder', () => {
  const bytes = loadBytesHex(join(fixturesDir, 'back-to-back-frames.bytes.hex'));
  const errors: FrameError[] = [];
  const { messages, remainder } = parseAll(bytes, {
    onFrameError: (err) => errors.push(err),
  });
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(remainder, []);
});

test('synthetic/bad-stx.bytes.hex -> 1 message (garbage 0x42 silently dropped)', () => {
  const bytes = loadBytesHex(join(fixturesDir, 'bad-stx.bytes.hex'));
  const errors: FrameError[] = [];
  const { messages, remainder } = parseAll(bytes, {
    onFrameError: (err) => errors.push(err),
  });
  assert.strictEqual(messages.length, 1);
  // Silent skip: no onFrameError fires for stray garbage. (See plan: "ONLY when
  // the entire remainder is consumed without finding a valid STX".)
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(remainder, []);
});

test('synthetic/partial-then-complete.bytes.hex -> 1 message when both halves are passed together', () => {
  const bytes = loadBytesHex(join(fixturesDir, 'partial-then-complete.bytes.hex'));
  const errors: FrameError[] = [];
  const { messages, remainder } = parseAll(bytes, {
    onFrameError: (err) => errors.push(err),
  });
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(remainder, []);
});

test('synthetic/truncated-frame.bytes.hex -> 0 messages, remainder = full input (no error)', () => {
  const bytes = loadBytesHex(join(fixturesDir, 'truncated-frame.bytes.hex'));
  const errors: FrameError[] = [];
  const { messages, remainder } = parseAll(bytes, {
    onFrameError: (err) => errors.push(err),
  });
  assert.strictEqual(messages.length, 0);
  assert.strictEqual(errors.length, 0);
  // Multiplexer can re-feed `remainder` once it has more bytes.
  assert.deepStrictEqual(remainder, bytes);
});

// ---------------------------------------------------------------------------
// bridge: parseAll(onFrameError) -> NdjsonEmitter.frame_error.
// typed FrameError flows from parseAll directly
// into NdjsonEmitter.frame_error, with NO stdout-warning interception anywhere
// in the call graph. We assert console.* spies all have callCount === 0 via
// node:test mocks (the spy bindings necessarily reference the global console).
// ---------------------------------------------------------------------------

import { mock } from 'node:test';
import { NdjsonEmitter } from '../output/ndjson.ts';

test('bridge: parseAll(onFrameError -> emitter.frame_error) emits one NDJSON line; no stdout-warning fires', () => {
  const bytes = loadBytesHex(join(fixturesDir, 'crc-mismatch.bytes.hex'));

  const stdoutLines: string[] = [];
  const emitter = new NdjsonEmitter({
    device_path: '/dev/null',
    out: (line) => stdoutLines.push(line),
  });

  // Spy on global console methods (warn/log/error) to assert NONE fire during
  // the parseAll -> emitter.frame_error bridge call graph.
  const warnSpy = mock.method(console, 'warn', () => {});
  const logSpy = mock.method(console, 'log', () => {});
  const errorSpy = mock.method(console, 'error', () => {});
  try {
    const { messages } = parseAll(bytes, {
      onFrameError: (err) => emitter.frame_error(err),
    });
    assert.strictEqual(messages.length, 0);
  } finally {
    warnSpy.mock.restore();
    logSpy.mock.restore();
    errorSpy.mock.restore();
  }

  assert.strictEqual(stdoutLines.length, 1, 'one NDJSON frame_error line emitted');
  const line = stdoutLines[0]!;
  assert.ok(line.endsWith('\n'));
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.strictEqual(parsed.event, 'frame_error');
  assert.strictEqual(parsed.error_code, 'crc_mismatch');
  assert.strictEqual(parsed.bytes_consumed, bytes.length);
  // The hex fields come from the typed FrameError, not a string parse.
  assert.ok(parsed.expected_crc_hex, 'expected_crc_hex populated');
  assert.ok(parsed.actual_crc_hex, 'actual_crc_hex populated');

  // no console.* fired anywhere in the pipeline.
  assert.strictEqual(warnSpy.mock.callCount(), 0, 'warn spy never called');
  assert.strictEqual(logSpy.mock.callCount(), 0, 'log spy never called');
  assert.strictEqual(errorSpy.mock.callCount(), 0, 'error spy never called');
});
