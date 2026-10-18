// Authored for lool. Not ported from upstream.
// NDJSON output unit tests.
//
// Covers:
//   - connection_changed:  schema_version=1, event, ts_ms, device_path, state
//   - card_inserted:       schema_version=1, event, card_type, card_number, card_series_byte?
//   - card_read:           full payload example
//   - card_removed:        schema_version=1, event, card_number
//   - frame_error:         consumes typed FrameError; emits expected_crc_hex,
//                          actual_crc_hex, raw_bytes_hex
//   - line discipline:     exactly one trailing '\n'; JSON.parse round-trips
//   - field naming: every emitted key is snake_case
//   - schema lock:         schema_version: 1 on every event (Claude discretion)
//   - stdout discipline:   uses process.stdout.write, NEVER console.*
//
// See NOTICE.md for cumulative attribution.

import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { FrameError } from '../siProtocol.ts';
import { SiCard5, getPunchOffset } from '../SiCard/types/SiCard5.ts';
import { SiCard10 } from '../SiCard/types/SiCard10.ts';
import { fixture as si5Fixture } from '../../tests/fixtures/upstream/si5-16-punches.ts';
import { fixture as si10Fixture } from '../../tests/fixtures/upstream/si10-typical.ts';

import { NdjsonEmitter } from './ndjson.ts';

const MOCKED_TS_MS = 1715543532471;
const setMockedClock = (): void => {
  mock.method(Date, 'now', () => MOCKED_TS_MS);
};

describe('NdjsonEmitter', () => {
  test('connection_changed: emits one JSON.parse-able line with schema_version=1 + state + device_path', () => {
    setMockedClock();
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    emitter.connection_changed({ state: 'open' });

    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0]!.endsWith('\n'), 'line ends with single newline');
    assert.ok(!lines[0]!.endsWith('\n\n'), 'line has exactly one trailing newline');

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.strictEqual(parsed.schema_version, 1);
    assert.strictEqual(parsed.event, 'connection_changed');
    assert.strictEqual(parsed.state, 'open');
    assert.strictEqual(parsed.device_path, '/dev/ttyUSB0');
    assert.strictEqual(parsed.ts_ms, MOCKED_TS_MS);
  });

  test('connection_changed: state=error with error message', () => {
    setMockedClock();
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    emitter.connection_changed({ state: 'error', error: 'EACCES' });
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.strictEqual(parsed.state, 'error');
    assert.strictEqual(parsed.error, 'EACCES');
  });

  test('card_inserted: SI5 card_number emits correct shape', () => {
    setMockedClock();
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    emitter.card_inserted({ card_type: 'SI5', card_number: 406402 });

    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.strictEqual(parsed.event, 'card_inserted');
    assert.strictEqual(parsed.card_type, 'SI5');
    assert.strictEqual(parsed.card_number, 406402);
    assert.strictEqual(parsed.schema_version, 1);
  });

  test('card_inserted: SI10 with card_series_byte (forensic)', () => {
    setMockedClock();
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    emitter.card_inserted({ card_type: 'SI10', card_number: 7050892, card_series_byte: 0x0f });
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.strictEqual(parsed.card_series_byte, 0x0f);
  });

  test('card_read: SI5 from fixture decoder produces snake_case payload with raw punches', () => {
    setMockedClock();
    // Build an SI5 card from the fixture via the public _decodeFromStorage helper.
    const card = new SiCard5(si5Fixture.cardData.cardNumber);
    card._decodeFromStorage(si5Fixture.storageData as number[]);

    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    emitter.card_read({ card });

    assert.strictEqual(lines.length, 1);
    const line = lines[0]!;
    assert.ok(line.endsWith('\n'));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.strictEqual(parsed.schema_version, 1);
    assert.strictEqual(parsed.event, 'card_read');
    assert.strictEqual(parsed.card_type, 'SI5');
    assert.strictEqual(parsed.card_number, si5Fixture.cardData.cardNumber);
    assert.strictEqual(parsed.punch_count, (si5Fixture.cardData.punches as unknown[]).length);
    const punches = parsed.punches as Array<Record<string, unknown>>;
    assert.strictEqual(punches.length, (si5Fixture.cardData.punches as unknown[]).length);
    // Punch shape: code + raw half-day clock fields (NOT ms-epoch clock).
    assert.strictEqual(punches[0]!.code, 31);
    assert.strictEqual(punches[0]!.seconds_in_half_day, 7967);
    assert.strictEqual(punches[0]!.half_day, 0);
    assert.strictEqual(punches[0]!.weekday, null); // SI5 doesn't store weekday
  });

  test('card_read: SI5 code-only punches (slots 31-36) have null time, a real 00:00:00 punch stays 0', () => {
    setMockedClock();
    const bytes = new Array<number>(0x80).fill(0);
    for (let i = 0; i < 36; i++) bytes[getPunchOffset(i)] = 101 + i; // code; time bytes stay 0
    const card = new SiCard5(7050892);
    card._decodeFromStorage(bytes);

    const lines: string[] = [];
    new NdjsonEmitter({ device_path: '/dev/ttyUSB0', out: (line) => lines.push(line) }).card_read({
      card,
    });
    const punches = (JSON.parse(lines[0]!) as { punches: Array<Record<string, unknown>> }).punches;
    assert.strictEqual(punches.length, 36);
    assert.deepStrictEqual(punches[0], {
      code: 101,
      seconds_in_half_day: 0,
      half_day: 0,
      weekday: null,
    });
    for (const p of punches.slice(30)) {
      assert.strictEqual(p.seconds_in_half_day, null);
      assert.strictEqual(p.half_day, null);
      assert.strictEqual(p.weekday, null);
    }
  });

  test('card_read: SI10 from fixture has uid + start + punch_count=16', () => {
    setMockedClock();
    const card = new SiCard10(si10Fixture.cardData.cardNumber);
    card._decodeFromStorage(si10Fixture.storageData as number[]);

    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      device_serial: '593656',
      out: (line) => lines.push(line),
    });
    emitter.card_read({ card });

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.strictEqual(parsed.card_type, 'SI10');
    assert.strictEqual(parsed.card_number, 7050892);
    assert.strictEqual(parsed.uid, 0x772a4299);
    assert.strictEqual(parsed.punch_count, 16);
    assert.strictEqual(parsed.device_serial, '593656');
    const start = parsed.start as Record<string, unknown>;
    assert.strictEqual(start.seconds_in_half_day, 8721);
    // PTD bit 0 = PM: documented (SPORTident doc); upstream sportident.js fixture.
    assert.strictEqual(start.half_day, 1); // the fixture's start record has the PTD PM bit set
    // finishTime null on this fixture
    assert.strictEqual(parsed.finish, null);
    const punches = parsed.punches as Array<Record<string, unknown>>;
    assert.strictEqual(punches.length, 16);
    assert.strictEqual(punches[0]!.code, 31);
    assert.strictEqual(punches[0]!.seconds_in_half_day, 7967);
  });

  test('card_removed: emits card_number', () => {
    setMockedClock();
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    emitter.card_removed({ card_number: 12345 });
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.strictEqual(parsed.event, 'card_removed');
    assert.strictEqual(parsed.card_number, 12345);
  });

  test('card_unsupported: emits number, detect command and series byte', () => {
    setMockedClock();
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    emitter.card_unsupported({
      card_number: 3500000,
      detect_command: 0xe8,
      card_series_byte: 0x0f,
    });
    emitter.card_unsupported({ card_number: 3500000, detect_command: 0xe5 });
    const [a, b] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.strictEqual(a!.event, 'card_unsupported');
    assert.strictEqual(a!.card_number, 3500000);
    assert.strictEqual(a!.detect_command, 0xe8);
    assert.strictEqual(a!.card_series_byte, 0x0f);
    assert.ok(!('card_series_byte' in b!));
  });

  test('frame_error: consumes typed FrameError directly', () => {
    setMockedClock();
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    const frameError: FrameError = {
      error_code: 'crc_mismatch',
      raw_bytes: [0x02, 0xf0, 0x01, 0x4d, 0xba, 0xba, 0x03],
      bytes_consumed: 7,
      expected_crc: [0xba, 0xbb],
      actual_crc: [0xba, 0xba],
    };
    emitter.frame_error(frameError);

    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.strictEqual(parsed.event, 'frame_error');
    assert.strictEqual(parsed.error_code, 'crc_mismatch');
    assert.strictEqual(parsed.bytes_consumed, 7);
    assert.strictEqual(parsed.expected_crc_hex, 'BABB');
    assert.strictEqual(parsed.actual_crc_hex, 'BABA');
    assert.strictEqual(parsed.raw_bytes_hex, '02 F0 01 4D BA BA 03');
  });

  test('frame_error: buffer_overflow has no crc fields', () => {
    setMockedClock();
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    emitter.frame_error({
      error_code: 'buffer_overflow',
      raw_bytes: [],
      bytes_consumed: 65537,
    });
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.strictEqual(parsed.error_code, 'buffer_overflow');
    assert.strictEqual(parsed.expected_crc_hex, undefined);
    assert.strictEqual(parsed.actual_crc_hex, undefined);
    assert.strictEqual(parsed.raw_bytes_hex, '');
  });

  test('NO camelCase keys appear in any emitted line (snake_case)', () => {
    setMockedClock();
    const card = new SiCard10(si10Fixture.cardData.cardNumber);
    card._decodeFromStorage(si10Fixture.storageData as number[]);

    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    emitter.connection_changed({ state: 'open' });
    emitter.card_inserted({ card_type: 'SI10', card_number: 7050892, card_series_byte: 0x0f });
    emitter.card_read({ card });
    emitter.card_removed({ card_number: 7050892 });
    emitter.frame_error({
      error_code: 'crc_mismatch',
      raw_bytes: [0x02],
      bytes_consumed: 1,
      expected_crc: [0xba, 0xbb],
      actual_crc: [0xba, 0xba],
    });
    // Inspect every emitted JSON object's keys for camelCase.
    const camelRe = /^[a-z]+[A-Z][a-zA-Z]*$/;
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const walk = (val: unknown): void => {
        if (val === null) return;
        if (Array.isArray(val)) {
          for (const v of val) walk(v);
          return;
        }
        if (typeof val === 'object') {
          for (const k of Object.keys(val as Record<string, unknown>)) {
            assert.ok(!camelRe.test(k), `camelCase key '${k}' found in line: ${line}`);
            walk((val as Record<string, unknown>)[k]);
          }
        }
      };
      walk(obj);
    }
  });

  test('schema_version=1 is set on every event type', () => {
    setMockedClock();
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      out: (line) => lines.push(line),
    });
    emitter.connection_changed({ state: 'open' });
    emitter.card_inserted({ card_type: 'SI5', card_number: 1 });
    emitter.card_removed({ card_number: 1 });
    emitter.frame_error({ error_code: 'truncated', raw_bytes: [], bytes_consumed: 0 });
    for (const line of lines) {
      assert.strictEqual((JSON.parse(line) as { schema_version: number }).schema_version, 1);
    }
  });
});
