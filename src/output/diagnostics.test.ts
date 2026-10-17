// Authored for lool. Not ported from upstream.
// emitDiagnostic unit tests.
//
// Covers: stderr one-line ISO-prefixed diagnostics, injected `err` defaults to
// process.stderr.write but can be overridden for capture in tests.
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { emitDiagnostic } from './diagnostics.ts';

describe('emitDiagnostic', () => {
  test('writes one ISO-prefixed line ending with single newline', () => {
    const out: string[] = [];
    emitDiagnostic('frame_error crc_mismatch: expected BABB, got 1234 (12 bytes consumed)', (s) =>
      out.push(s)
    );
    assert.strictEqual(out.length, 1);
    const line = out[0]!;
    assert.ok(line.endsWith('\n'), 'ends with newline');
    assert.ok(!line.endsWith('\n\n'), 'single newline only');
    // ISO 8601 prefix in square brackets: [2026-05-12T...Z]
    assert.match(line, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /);
    assert.ok(line.includes('frame_error crc_mismatch'));
  });
});
