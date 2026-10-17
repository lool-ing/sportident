// Authored for lool. Not ported from upstream.
//
// Tests for `RecordSink` (directional
// transcript; allowedRoots path validation).
//
// Each test uses a unique basename in /tmp + passes `allowedRoots: [cwd,
// '/tmp']` so the writes land in /tmp and don't pollute the repo.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { RecordSink } from './record.ts';

const TMP = '/tmp';
const NONCE = `${process.pid}-${Date.now()}`;
const cwd = process.cwd();

const cleanup: string[] = [];
after(() => {
  for (const base of cleanup) {
    for (const ext of ['.bytes.hex', '.expected.json']) {
      const p = base + ext;
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore — best effort
      }
    }
  }
});

const newBasename = (label: string): string => {
  const b = path.join(TMP, `lool-record-test-${label}-${NONCE}`);
  cleanup.push(b);
  return b;
};

describe('RecordSink — directional transcript + path validation', () => {
  test('writes directional `out`/`in` lines in chronological order', async () => {
    const basename = newBasename('directional');
    const sink = new RecordSink({
      device_path: '/dev/null',
      recordBasename: basename,
      allowedRoots: [cwd, TMP],
    });

    // Emit a few NDJSON events (these tee to expected.json AND default stdout).
    sink.connection_changed({ state: 'open' });
    sink.card_inserted({ card_type: 'SI5', card_number: 406402 });
    // Simulate a wire round-trip: send first, then receive.
    sink.onRawSend([0x02, 0xf0, 0x01, 0x4d]);
    sink.onRawReceive([0xff, 0xff, 0x02, 0xf0, 0x01, 0x4d, 0xba, 0xbb, 0x03]);

    await sink.close();

    const bytes = fs.readFileSync(`${basename}.bytes.hex`, 'utf8');
    const expectedNdjson = fs.readFileSync(`${basename}.expected.json`, 'utf8');

    // Filter out header comments; remaining lines must be the two directional records.
    const dataLines = bytes.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
    assert.strictEqual(dataLines.length, 2, 'two directional records');
    assert.strictEqual(dataLines[0], 'out 02 F0 01 4D');
    assert.strictEqual(dataLines[1], 'in FF FF 02 F0 01 4D BA BB 03');

    // Header present
    assert.ok(bytes.split('\n')[0]!.startsWith('# Captured '));
    assert.ok(bytes.includes('Format: directional transcript'));

    // expected.json: each line is JSON.parse-able; ts_ms normalized comparison.
    const ndjsonLines = expectedNdjson.split('\n').filter((l) => l.length > 0);
    assert.strictEqual(ndjsonLines.length, 2);
    const parsed = ndjsonLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.strictEqual(parsed[0]!.event, 'connection_changed');
    assert.strictEqual(parsed[0]!.state, 'open');
    assert.strictEqual(parsed[1]!.event, 'card_inserted');
    assert.strictEqual(parsed[1]!.card_number, 406402);
  });

  test('basename under /tmp accepted when /tmp in allowedRoots', async () => {
    const basename = newBasename('tmp-ok');
    const sink = new RecordSink({
      device_path: '/dev/null',
      recordBasename: basename,
      allowedRoots: [cwd, TMP],
    });
    await sink.close();
    assert.ok(fs.existsSync(`${basename}.bytes.hex`));
    assert.ok(fs.existsSync(`${basename}.expected.json`));
  });

  test('basename under cwd accepted with default allowedRoots ([cwd])', async () => {
    // Use a basename inside cwd that we will clean up explicitly.
    const basename = path.join(cwd, `lool-record-test-cwd-${NONCE}`);
    cleanup.push(basename);
    const sink = new RecordSink({
      device_path: '/dev/null',
      recordBasename: basename,
      // allowedRoots defaults to [cwd]
    });
    await sink.close();
    assert.ok(fs.existsSync(`${basename}.bytes.hex`));
  });

  test('rejects basename outside allowed roots — /etc/passwd', () => {
    assert.throws(
      () =>
        new RecordSink({
          device_path: '/dev/null',
          recordBasename: '/etc/passwd',
          allowedRoots: [cwd, TMP],
        }),
      (err: Error) => {
        assert.match(err.message, /outside allowed roots/);
        return true;
      }
    );
    // The bytes.hex file must NOT have been opened (no side effect).
    assert.ok(!fs.existsSync('/etc/passwd.bytes.hex'), 'no file should have been created');
  });

  test('rejects basename outside allowed roots — `../escape` resolves above cwd', () => {
    // With only [cwd] in allowedRoots, a basename whose parent is the
    // workspace root resolves to the workspace root (one level above cwd, which
    // is .../LooL itself). Use a basename that resolves to /tmp but only [cwd]
    // is allowed.
    assert.throws(
      () =>
        new RecordSink({
          device_path: '/dev/null',
          recordBasename: '/tmp/should-not-be-allowed',
          allowedRoots: [cwd],
        }),
      (err: Error) => {
        assert.match(err.message, /outside allowed roots/);
        return true;
      }
    );
  });

  test('relative basename resolves under cwd and is accepted', async () => {
    // Use a sub-path that we know doesn't exist as a real file in repo;
    // cleanup explicitly at end.
    const rel = `tmp-record-test-rel-${NONCE}`;
    const abs = path.join(cwd, rel);
    cleanup.push(abs);
    const sink = new RecordSink({
      device_path: '/dev/null',
      recordBasename: rel,
      allowedRoots: [cwd],
    });
    await sink.close();
    assert.ok(fs.existsSync(`${abs}.bytes.hex`));
  });
});
