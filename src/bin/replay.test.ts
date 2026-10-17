// Authored for lool. Not ported from upstream.
//
// Tests for `replayFixture` (deterministic
// playback via directional transcript).
//
// Each test materialises a synthetic basename pair in /tmp (bytes.hex +
// expected.json), runs replayFixture, asserts `matches`. The transcript is
// derived by running the same handshake-and-card-read sequence through the
// production pipeline once with a FakeSerialTransport and tee'ing the wire
// bytes — encoded inline below to keep the test hermetic.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

import { render } from '../siProtocol.ts';
import { proto } from '../constants.ts';
import { STATION_CONFIG_OFFSETS, StationMode } from '../SiStation/BaseSiStation.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { SiMainStation } from '../SiStation/SiMainStation.ts';
import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import { RecordSink } from './record.ts';
import { replayFixture } from './replay.ts';

import { fixture as si5Fixture } from '../../tests/fixtures/upstream/si5-16-punches.ts';

const TMP = '/tmp';
const NONCE = `${process.pid}-${Date.now()}`;
const cwd = process.cwd();

const cleanup: string[] = [];
after(() => {
  for (const base of cleanup) {
    for (const ext of ['.bytes.hex', '.expected.json']) {
      try {
        fs.unlinkSync(base + ext);
      } catch {
        // ignore
      }
    }
  }
});

const newBasename = (label: string): string => {
  const b = path.join(TMP, `lool-replay-test-${label}-${NONCE}`);
  cleanup.push(b);
  return b;
};

// ----------------------------------------------------------------------------
// A minimal recording transport that tees sends + receives into a RecordSink,
// driving SiMainStation against canned response rules. Used to build a "real"
// fixture pair from the production code path so the replay test isn't coupled
// to hard-coded hex strings — those would drift the day SiMainStation's
// handshake order changes.
// ----------------------------------------------------------------------------

type Matcher = (chunk: number[]) => boolean;
type Handler = (chunk: number[]) => number[] | void;

class RecordingFakeTransport extends EventEmitter implements ISerialTransport {
  private rules: { matcher: Matcher; handler: Handler }[] = [];
  private closed = false;
  private sink: RecordSink | null = null;

  setSink(sink: RecordSink): void {
    this.sink = sink;
  }

  open(): Promise<void> {
    return Promise.resolve();
  }

  send(bytes: number[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'));
    this.sink?.onRawSend(bytes);
    const rule = this.rules.find((r) => r.matcher(bytes));
    if (rule) {
      const resp = rule.handler(bytes);
      if (resp !== undefined) {
        setImmediate(() => {
          this.sink?.onRawReceive(resp);
          this.emit('data', resp);
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

  addRule(matcher: Matcher, handler: Handler): void {
    this.rules.push({ matcher, handler });
  }

  inject(bytes: number[]): void {
    this.sink?.onRawReceive(bytes);
    setImmediate(() => this.emit('data', bytes));
  }
}

const renderFrame = (command: number, parameters: number[]): number[] =>
  render({ command, parameters });

const makeStationConfigBlob = (): number[] => {
  const cfg = new Array<number>(128).fill(0x00);
  // Pre-handshake state: Workstation mode, code=1. Handshake-flag bits
  // (0x73/0x74) stay 0x00 — replay tests don't assert bit-merge semantics
  // (that's covered in SiMainStation.test.ts); they just need the handshake
  // to complete without errors so card-replay flows can run.
  cfg[STATION_CONFIG_OFFSETS.MODE] = StationMode.Workstation;
  cfg[STATION_CONFIG_OFFSETS.CODE_LOW] = 1;
  return cfg;
};

const setUpHandshakeRules = (fake: RecordingFakeTransport): void => {
  // Real-wire response shapes (bench transcript 2026-05-13 /dev/ttyUSB0):
  //   SET_MS:      [addr_hi=00, addr_lo=0A, P_MS_DIRECT]
  //   GET_SYS_VAL: [addr_hi=00, addr_lo=0A, offset_echo=00, ...128 config]
  //   SET_SYS_VAL: [addr_hi=00, addr_lo=0A, offset_echo]
  fake.addRule(
    (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.SET_MS,
    () => renderFrame(proto.cmd.SET_MS, [0x00, 0x0a, proto.P_MS_DIRECT])
  );
  fake.addRule(
    (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.GET_SYS_VAL,
    () => renderFrame(proto.cmd.GET_SYS_VAL, [0x00, 0x0a, 0x00, ...makeStationConfigBlob()])
  );
  fake.addRule(
    (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.SET_SYS_VAL,
    (c) => renderFrame(proto.cmd.SET_SYS_VAL, [0x00, 0x0a, c[4] as number])
  );
};

const buildSi5DetFrame = (cardNumber: number): number[] => {
  const mid = Math.floor(cardNumber / 100000) & 0xff;
  const residual = cardNumber - mid * 100000;
  const hi = (residual >> 8) & 0xff;
  const lo = residual & 0xff;
  return renderFrame(proto.cmd.SI5_DET, [0x00, 0x00, 0x00, mid, hi, lo]);
};

// Capture a real fixture pair via the production pipeline.
const captureFixture = async (basename: string): Promise<void> => {
  const fake = new RecordingFakeTransport();
  setUpHandshakeRules(fake);

  const sink = new RecordSink({
    device_path: '/dev/ttyUSB0',
    device_serial: 'test',
    recordBasename: basename,
    allowedRoots: [cwd, TMP],
  });
  fake.setSink(sink);

  const station = new SiMainStation(fake);

  // Connect sink to station events the same way bin/lool-readout does. The
  // sink IS an NdjsonEmitter so we wire to its event methods.
  station.on('connectionChanged', (state: 'opening' | 'open' | 'closed' | 'error') =>
    sink.connection_changed({ state })
  );
  station.on('cardInserted', (card: BaseSiCard) =>
    sink.card_inserted({ card_type: 'SI5', card_number: card.cardNumber })
  );
  station.on('cardRead', (card: BaseSiCard) => sink.card_read({ card }));

  // emit a manual opening event BEFORE transport.open()
  // so the captured fixture mirrors the bin's lifecycle. replayFixture also
  // emits a manual opening, so round-trip parity requires both sides to do it.
  sink.connection_changed({ state: 'opening' });

  await fake.open();
  await station.readCards();

  // Real-wire GET_SI5 response: [addr_hi, addr_lo, ...128 data].
  fake.addRule(
    (c) => c[0] === proto.WAKEUP && c[2] === proto.cmd.GET_SI5,
    () => renderFrame(proto.cmd.GET_SI5, [0x00, 0x0a, ...(si5Fixture.storageData as number[])])
  );

  fake.inject(buildSi5DetFrame(si5Fixture.cardData.cardNumber));
  await new Promise((r) => setTimeout(r, 60));
  await station.close();
  await sink.close();
};

describe('replayFixture — deterministic playback through directional transcript', () => {
  test('round-trip matches=true on a freshly captured fixture', async () => {
    const basename = newBasename('roundtrip');
    await captureFixture(basename);

    const result = await replayFixture(basename, { allowedRoots: [cwd, TMP] });
    assert.strictEqual(result.matches, true, `expected match; got diff: ${result.diff ?? ''}`);
  });

  test('corrupted expected.json -> matches=false with non-empty diff', async () => {
    const basename = newBasename('corrupt-expected');
    await captureFixture(basename);

    // Read the captured expected.json, mutate one punch code by 1, write back.
    const raw = fs.readFileSync(`${basename}.expected.json`, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    // Find a card_read line and rewrite its first punch code.
    const idx = lines.findIndex((l) => l.includes('"event":"card_read"'));
    assert.ok(idx >= 0, 'card_read line should exist');
    const cardRead = JSON.parse(lines[idx]!) as Record<string, unknown>;
    const punches = cardRead.punches as Array<{ code: number }>;
    assert.ok(punches.length > 0, 'fixture should have punches');
    punches[0]!.code = (punches[0]!.code + 1) & 0xff;
    lines[idx] = JSON.stringify(cardRead);
    fs.writeFileSync(`${basename}.expected.json`, lines.join('\n') + '\n');

    const result = await replayFixture(basename, { allowedRoots: [cwd, TMP] });
    assert.strictEqual(result.matches, false);
    assert.ok(result.diff && result.diff.length > 0, 'diff should be non-empty');
  });

  test('corrupted transcript (out order changed) -> matches=false', async () => {
    const basename = newBasename('corrupt-transcript');
    await captureFixture(basename);

    // Mangle the bytes.hex: change a non-WAKEUP byte of the first `out` line so
    // the replay's send-assertion catches the mismatch. The first byte of every
    // `out` is WAKEUP (FF) so we mutate the second byte instead, replacing the
    // STX (02) with AA — guaranteed to differ from what the station sends.
    const raw = fs.readFileSync(`${basename}.bytes.hex`, 'utf8');
    const lines = raw.split('\n');
    const firstOutIdx = lines.findIndex((l) => l.startsWith('out '));
    assert.ok(firstOutIdx >= 0, 'at least one out line');
    // Replace the second hex byte (STX 02 -> AA) — will not match SiMainStation's send.
    lines[firstOutIdx] = lines[firstOutIdx]!.replace(/^out ([0-9A-F]{2}) [0-9A-F]{2}/, 'out $1 AA');
    fs.writeFileSync(`${basename}.bytes.hex`, lines.join('\n'));

    const result = await replayFixture(basename, { allowedRoots: [cwd, TMP] });
    assert.strictEqual(result.matches, false);
    assert.ok(
      result.diff && /out mismatch/.test(result.diff),
      `expected 'out mismatch' in diff; got: ${result.diff ?? ''}`
    );
  });
});
