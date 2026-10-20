// Authored for lool. Not ported from upstream.
//
// Regression tests for the --device / --record / --replay argument parser.
// Guards against `--device --once` silently absorbing `--once` as the device path
// because the original parser only checked for `undefined`, not for a
// following flag-looking token.
//
// Also covers the `--flag=value` form, for parity with common CLI
// conventions.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from './lool-readout.ts';

describe('parseArgs hardening', () => {
  test('happy path: positional values for all three string flags', () => {
    const opts = parseArgs([
      '--device',
      '/dev/ttyUSB1',
      '--record',
      'fixtures/run',
      '--replay',
      'fixtures/old',
    ]);
    assert.strictEqual(opts.device, '/dev/ttyUSB1');
    assert.strictEqual(opts.record, 'fixtures/run');
    assert.strictEqual(opts.replay, 'fixtures/old');
  });

  test('--flag=value form is accepted for all three string flags', () => {
    const opts = parseArgs([
      '--device=/dev/ttyUSB2',
      '--record=fixtures/inline',
      '--replay=fixtures/inline2',
    ]);
    assert.strictEqual(opts.device, '/dev/ttyUSB2');
    assert.strictEqual(opts.record, 'fixtures/inline');
    assert.strictEqual(opts.replay, 'fixtures/inline2');
  });

  test('boolean flags toggle without consuming a value', () => {
    const opts = parseArgs(['--device', '/dev/ttyUSB0', '--once', '--include-raw-pages']);
    assert.strictEqual(opts.once, true);
    assert.strictEqual(opts.includeRawPages, true);
  });

  test('--pretty is off by default and toggles on', () => {
    assert.strictEqual(parseArgs([]).pretty, false);
    assert.strictEqual(parseArgs(['--pretty']).pretty, true);
  });

  test('--measure-siac-battery is off by default and toggles on', () => {
    assert.strictEqual(parseArgs([]).measureSiacBattery, false);
    assert.strictEqual(parseArgs(['--measure-siac-battery']).measureSiacBattery, true);
  });

  test('regression: --device followed by another flag throws (does not absorb --once)', () => {
    assert.throws(() => parseArgs(['--device', '--once']), /--device requires a value/);
  });

  test('regression: --record followed by another flag throws', () => {
    assert.throws(() => parseArgs(['--record', '--once']), /--record requires a value/);
  });

  test('regression: --replay followed by another flag throws', () => {
    assert.throws(
      () => parseArgs(['--replay', '--include-raw-pages']),
      /--replay requires a value/
    );
  });

  test('trailing --device with no value throws', () => {
    assert.throws(() => parseArgs(['--device']), /--device requires a value/);
  });

  test('empty value via --flag= form is rejected', () => {
    assert.throws(() => parseArgs(['--device=']), /--device requires a value/);
  });

  test('unknown argument throws', () => {
    assert.throws(() => parseArgs(['--bogus']), /Unknown argument: --bogus/);
  });
});
