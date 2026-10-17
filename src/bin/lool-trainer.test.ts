// Authored for lool. Not ported from upstream.
//
// Unit tests for lool-trainer's pure functions: the --course parser and
// the lenient subsequence course-matcher. The full station-pipeline is
// already exercised by replay-bench-fixtures.test.ts; this file just guards
// the trainer-specific logic so a refactor doesn't quietly break what an
// operator sees on stderr during a real run.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { matchCourse, parseTrainerArgs, toCardSummary } from './lool-trainer.ts';
import type { CardSummary } from './lool-trainer.ts';

const complete = (punches: number[]): CardSummary => ({
  punches,
  hasStart: true,
  hasFinish: true,
});

describe('matchCourse (lenient subsequence + start/finish gates)', () => {
  test('exact match in order returns ok', () => {
    assert.deepStrictEqual(matchCourse(complete([136, 110]), [136, 110]), { ok: true });
  });

  test('extras between expected codes still ok', () => {
    assert.deepStrictEqual(matchCourse(complete([136, 42, 110]), [136, 110]), { ok: true });
  });

  test('extras before and after still ok', () => {
    assert.deepStrictEqual(matchCourse(complete([1, 136, 2, 110, 3]), [136, 110]), { ok: true });
  });

  test('wrong order is MP with reason wrong_order', () => {
    const r = matchCourse(complete([110, 136]), [136, 110]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'wrong_order');
    assert.strictEqual(r.missingCode, 110);
  });

  test('missing second control is MP missing_control', () => {
    const r = matchCourse(complete([136]), [136, 110]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'missing_control');
    assert.strictEqual(r.missingCode, 110);
  });

  test('missing first control is MP missing_control', () => {
    const r = matchCourse(complete([110]), [136, 110]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'missing_control');
    assert.strictEqual(r.missingCode, 136);
  });

  test('empty punches with non-empty course is MP no_punches', () => {
    const r = matchCourse(complete([]), [136, 110]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no_punches');
  });

  test('empty course still requires finish by default (start not required)', () => {
    assert.deepStrictEqual(matchCourse(complete([]), []), { ok: true });
    assert.deepStrictEqual(matchCourse({ punches: [], hasStart: true, hasFinish: false }, []), {
      ok: false,
      reason: 'missing_finish',
    });
    // No start punch is fine by default (most classes use start-list times).
    assert.deepStrictEqual(matchCourse({ punches: [], hasStart: false, hasFinish: true }, []), {
      ok: true,
    });
  });

  test('regression bench 2026-05-14: course OK but finish missing -> MP missing_finish', () => {
    // The case Jonas hit: card has 136 → 110 in punches but finish is null.
    const r = matchCourse({ punches: [136, 110], hasStart: true, hasFinish: false }, [136, 110]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'missing_finish');
  });

  test('default: missing start is OK (start time comes from start list, not card)', () => {
    const r = matchCourse({ punches: [136, 110], hasStart: false, hasFinish: true }, [136, 110]);
    assert.deepStrictEqual(r, { ok: true });
  });

  test('--require-start opt-in: missing start now MP (open class / kids)', () => {
    const r = matchCourse({ punches: [136, 110], hasStart: false, hasFinish: true }, [136, 110], {
      requireStart: true,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'missing_start');
  });

  test('--no-finish opt: missing finish tolerated, course still validated', () => {
    const r = matchCourse({ punches: [136, 110], hasStart: true, hasFinish: false }, [136, 110], {
      requireFinish: false,
    });
    assert.deepStrictEqual(r, { ok: true });
  });

  test('long course with single break is MP', () => {
    const r = matchCourse(complete([31, 32, 33, 35, 36]), [31, 32, 33, 34, 35]);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'missing_control');
    assert.strictEqual(r.missingCode, 34);
  });
});

describe('toCardSummary (bench 2026-05-14 null-vs-undefined regression)', () => {
  // SiTimestamp values, used as truthy non-null markers; the function only
  // cares about the != null distinction, not the timestamp contents.
  const ts = { seconds_in_half_day: 1234, half_day: 0 as 0 | 1, weekday: null };

  test('null startTime/finishTime resolve to hasStart/hasFinish false', () => {
    // The exact shape the SI card decoder produces when the runner did NOT
    // punch the finish station — startTime/finishTime are set to null, not
    // undefined. This was the bench bug: the previous `!== undefined` check
    // saw null as "present" and the trainer printed ✓ OK.
    const s = toCardSummary({ punches: [{ code: 31 }], startTime: null, finishTime: null });
    assert.strictEqual(s.hasStart, false);
    assert.strictEqual(s.hasFinish, false);
    assert.deepStrictEqual(s.punches, [31]);
  });

  test('undefined timestamps also resolve to false', () => {
    const s = toCardSummary({ punches: [] });
    assert.strictEqual(s.hasStart, false);
    assert.strictEqual(s.hasFinish, false);
    assert.deepStrictEqual(s.punches, []);
  });

  test('truthy timestamps resolve to true', () => {
    const s = toCardSummary({ punches: [{ code: 136 }], startTime: ts, finishTime: ts });
    assert.strictEqual(s.hasStart, true);
    assert.strictEqual(s.hasFinish, true);
    assert.deepStrictEqual(s.punches, [136]);
  });

  test('omitted punches array resolves to []', () => {
    const s = toCardSummary({ startTime: ts, finishTime: ts });
    assert.deepStrictEqual(s.punches, []);
  });
});

describe('parseTrainerArgs', () => {
  test('defaults: device from env or /dev/ttyUSB0, course 136,110, bell off', () => {
    const opts = parseTrainerArgs([]);
    assert.strictEqual(opts.bell, false);
    assert.deepStrictEqual(opts.course, [136, 110]);
  });

  test('--course parses comma list to numbers', () => {
    const opts = parseTrainerArgs(['--course', '31,32,33']);
    assert.deepStrictEqual(opts.course, [31, 32, 33]);
  });

  test('--course=value form works', () => {
    const opts = parseTrainerArgs(['--course=200,201']);
    assert.deepStrictEqual(opts.course, [200, 201]);
  });

  test('--bell toggles', () => {
    const opts = parseTrainerArgs(['--bell']);
    assert.strictEqual(opts.bell, true);
  });

  test('defaults: start optional, finish required (matches start-list classes)', () => {
    const opts = parseTrainerArgs([]);
    assert.strictEqual(opts.requireStart, false);
    assert.strictEqual(opts.requireFinish, true);
  });

  test('--require-start opts into open-class semantics', () => {
    const opts = parseTrainerArgs(['--require-start']);
    assert.strictEqual(opts.requireStart, true);
  });

  test('--no-finish disables the finish check (testing/debug)', () => {
    const opts = parseTrainerArgs(['--no-finish']);
    assert.strictEqual(opts.requireFinish, false);
  });

  test('--device gets propagated', () => {
    const opts = parseTrainerArgs(['--device', '/dev/ttyUSB1']);
    assert.strictEqual(opts.device, '/dev/ttyUSB1');
  });

  test('--course --bell does not absorb --bell as course value', () => {
    assert.throws(() => parseTrainerArgs(['--course', '--bell']), /--course requires a value/);
  });

  test('non-numeric code in --course throws', () => {
    assert.throws(() => parseTrainerArgs(['--course', '136,abc']), /comma-separated/);
  });

  test('decimal code in --course throws (no silent truncation)', () => {
    assert.throws(() => parseTrainerArgs(['--course', '110.5,136']), /comma-separated/);
  });

  test('empty --course= throws', () => {
    assert.throws(() => parseTrainerArgs(['--course=']), /--course requires a value/);
  });

  test('unknown argument throws', () => {
    assert.throws(() => parseTrainerArgs(['--bogus']), /Unknown argument: --bogus/);
  });
});
