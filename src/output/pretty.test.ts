// Authored for lool. Not ported from upstream.
// formatEvent unit tests for `lool-readout --pretty`.
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { formatEvent } from './pretty.ts';
import type { CardReadEvent } from './ndjson.ts';

const punch = (code: number, s: number, half_day: 0 | 1 = 0) => ({
  code,
  seconds_in_half_day: s,
  half_day,
  weekday: null,
});

const cardRead = (over: Partial<CardReadEvent>): CardReadEvent => ({
  schema_version: 1,
  event: 'card_read',
  ts_ms: 0,
  device_path: '/dev/ttyUSB0',
  card_type: 'SIAC',
  card_number: 8529954,
  start: null,
  finish: null,
  check: { seconds_in_half_day: 27608, half_day: 0, weekday: null },
  clear: null,
  punch_count: 0,
  punches: [],
  card_holder: null,
  ...over,
});

describe('formatEvent card_read', () => {
  test('collapses back-to-back double punches and numbers controls in order', () => {
    const text = formatEvent(
      cardRead({
        punch_count: 5,
        punches: [
          punch(71, 28366),
          punch(71, 28370),
          punch(53, 28628),
          punch(53, 28631),
          punch(100, 29473),
        ],
      })
    );
    assert.match(text, /^── SIAC 8529954 ─/);
    assert.match(text, /Check {4}07:40:08/);
    assert.match(text, /^ +1 +71 +07:52:46 +\(2×\)$/m);
    assert.match(text, /^ +2 +53 +07:57:08 +4:22 +\(2×\)$/m);
    assert.match(text, /^ +3 +100 +08:11:13 +14:05$/m);
    assert.match(text, /5 punches, 3 controls/);
  });

  test('split, total and finish relative to start, across the AM/PM boundary', () => {
    const text = formatEvent(
      cardRead({
        start: { seconds_in_half_day: 43000, half_day: 0, weekday: null },
        finish: { seconds_in_half_day: 400, half_day: 1, weekday: null },
        punch_count: 1,
        punches: [punch(31, 100, 1)],
      })
    );
    assert.match(text, /^ +1 +31 +12:01:40 +5:00 +5:00$/m);
    assert.match(text, /Finish {3}12:06:40 {2}split 5:00 {2}total 10:00/);
  });

  test('SI5 has no AM/PM bit: elapsed time wraps over 12 hours', () => {
    const text = formatEvent(
      cardRead({
        card_type: 'SI5',
        start: { seconds_in_half_day: 42600, half_day: 0, weekday: null },
        finish: { seconds_in_half_day: 600, half_day: 0, weekday: null },
      })
    );
    assert.match(text, /total 20:00$/m);
  });
});
