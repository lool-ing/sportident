// Authored for lool. Not ported from upstream.
//
// Bench-fixture replay regression test. Drives each of the
// four committed bench fixtures (SI5/SI9/SI10/SIAC, captured 2026-05-13 on
// /dev/ttyUSB0 via lool-readout --record --once) through the production
// replayFixture pipeline and asserts the produced wire-protocol NDJSON events
// (card_inserted, card_read, card_removed, frame_error) match the captured
// .expected.json byte-for-byte (ts_ms normalised to 0).
//
// `connection_changed` events are intentionally EXCLUDED from the comparison
// because they originate in the transport-lifecycle (SerialTransport.open()
// emits state transitions), not on the wire. The bench captures embed real-
// hardware timing artefacts (e.g. two consecutive `opening` events before
// `open` is reached because USB enumeration is slow) that the synchronous
// PlaybackTransport will never reproduce. Protocol behaviour — what cards
// were detected and what their decoded payload looks like — is what we want
// to regression-test, and that lives in the card_* events.
//
// This is the "ours" half of the two-source fixture strategy: real-wire
// transcripts captured from a bench BSM7/8-USB. The upstream fixtures live in
// tests/fixtures/upstream/ and exercise card decoders directly; the bench
// fixtures here exercise the full pipeline including handshake +
// station read + NDJSON emit against bytes that actually came off
// the wire.
//
// Future regressions in any layer touched by replay — SiTargetMultiplexer,
// SiMainStation handshake order, frame-slice arithmetic, SiCard5/8 decoders,
// NdjsonEmitter snake_case at boundary — will surface here.
//
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { EventEmitter } from 'node:events';

import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { SiMainStation } from '../SiStation/SiMainStation.ts';
import { NdjsonEmitter } from '../output/ndjson.ts';
import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import type { FrameError } from '../siProtocol.ts';
import { legacyErasedPageReply } from '../bin/replay.ts';

// Resolve the fixture directory relative to THIS test file, not process.cwd().
// A cwd-relative path breaks when the tests run from another directory.
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '..', '..', 'tests', 'fixtures', 'bench');

interface CardTypeMeta {
  readonly card_type: 'SI5' | 'SI6' | 'SI8' | 'SI9' | 'SI10' | 'SI11' | 'SIAC';
}

const CARDS: ReadonlyArray<{ slug: string; expectedType: CardTypeMeta['card_type'] }> = [
  { slug: 'si5', expectedType: 'SI5' },
  // SI6 + SI8: captured 2026-10-03 on a serial BSM through a PL2303 adapter.
  { slug: 'si6', expectedType: 'SI6' },
  { slug: 'si8', expectedType: 'SI8' },
  { slug: 'si9', expectedType: 'SI9' },
  { slug: 'si10', expectedType: 'SI10' },
  { slug: 'siac', expectedType: 'SIAC' },
];

// Inline mini-replay engine: drives the production SiMainStation + NdjsonEmitter
// against the bench transcript, captures emitted NDJSON, filters out lifecycle
// events. Mirrors replayFixture but skips the closing transport lifecycle so we
// can isolate wire-protocol behaviour.

type Direction = 'out' | 'in';
interface Step {
  dir: Direction;
  bytes: number[];
}

const hexEncode = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

const parseTranscript = (raw: string): Step[] => {
  const steps: Step[] = [];
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const m = /^(out|in)\s+([0-9A-Fa-f \t]+)$/.exec(line);
    assert.ok(m, `bad transcript line: ${JSON.stringify(line)}`);
    const dir = m[1] as Direction;
    const bytes = m[2]!
      .split(/\s+/)
      .filter((s) => s.length > 0)
      .map((s) => parseInt(s, 16));
    steps.push({ dir, bytes });
  }
  return steps;
};

class BenchPlaybackTransport extends EventEmitter implements ISerialTransport {
  private cursor = 0;
  private error: string | null = null;
  private readonly steps: Step[];
  constructor(steps: Step[]) {
    super();
    this.steps = steps;
  }
  open(): Promise<void> {
    return Promise.resolve();
  }
  send(bytes: number[]): Promise<void> {
    if (this.error) return Promise.reject(new Error(this.error));
    // the production pipeline now sends a bare ACK
    // (0x06) after every successful card read. The committed bench fixtures
    // were captured BEFORE this fix (2026-05-13 bench session) and so don't
    // contain the trailing `out 06`. To preserve the bench transcripts as
    // frozen truth, silently swallow bare-ACK sends that aren't in the
    // fixture stream — they're a real-wire artefact this test doesn't
    // regression-protect. Re-captured fixtures will include
    // the ACK and the cursor will line up; both shapes match here.
    if (bytes.length === 1 && bytes[0] === 0x06) {
      const step = this.steps[this.cursor];
      if (
        step === undefined ||
        step.dir !== 'out' ||
        step.bytes.length !== 1 ||
        step.bytes[0] !== 0x06
      ) {
        return Promise.resolve();
      }
      // Fixture DOES include the ACK at the cursor — fall through and
      // advance the cursor like any other matching out step.
    }
    const step = this.steps[this.cursor];
    // Captures from before block-1/block-3 support: see legacyErasedPageReply.
    const legacy = legacyErasedPageReply(bytes);
    if (
      legacy !== undefined &&
      (step === undefined || hexEncode(step.bytes) !== hexEncode(bytes))
    ) {
      setImmediate(() => this.emit('data', legacy));
      return Promise.resolve();
    }
    if (!step || step.dir !== 'out') {
      this.error = `out mismatch at cursor=${this.cursor} (sent ${hexEncode(bytes)})`;
      return Promise.reject(new Error(this.error));
    }
    if (hexEncode(step.bytes) !== hexEncode(bytes)) {
      this.error = `out byte mismatch at step ${this.cursor}`;
      return Promise.reject(new Error(this.error));
    }
    this.cursor++;
    // Emit every consecutive `in` chunk that follows.
    while (this.cursor < this.steps.length && this.steps[this.cursor]!.dir === 'in') {
      const chunk = this.steps[this.cursor]!.bytes;
      this.cursor++;
      setImmediate(() => this.emit('data', chunk));
    }
    return Promise.resolve();
  }
  close(): Promise<void> {
    setImmediate(() => this.emit('close'));
    return Promise.resolve();
  }
  pumpRemaining(perTickMs: number = 5): Promise<void> {
    return new Promise<void>((resolve) => {
      const tick = (): void => {
        const step = this.steps[this.cursor];
        if (!step || step.dir === 'out') return resolve();
        this.cursor++;
        setImmediate(() => this.emit('data', step.bytes));
        setTimeout(tick, perTickMs);
      };
      setTimeout(tick, perTickMs);
    });
  }
  getError(): string | null {
    return this.error;
  }
}

const normaliseTs = (line: string): string => {
  const obj = JSON.parse(line) as Record<string, unknown>;
  obj.ts_ms = 0;
  return JSON.stringify(obj);
};

const captureBenchReplay = async (basename: string): Promise<string[]> => {
  const bytesRaw = fs.readFileSync(`${basename}.bytes.hex`, 'utf8');
  const steps = parseTranscript(bytesRaw);
  const transport = new BenchPlaybackTransport(steps);

  const captured: string[] = [];
  const emitter = new NdjsonEmitter({
    device_path: '/dev/ttyUSB0',
    out: (line) => captured.push(line),
  });
  const station = new SiMainStation(transport);
  station.on('connectionChanged', (state: 'opening' | 'open' | 'closed' | 'error') =>
    emitter.connection_changed({ state })
  );
  station.on('cardInserted', (card: BaseSiCard) => {
    const typeName = card.constructor.name;
    const TYPE_MAP: Record<string, CardTypeMeta['card_type']> = {
      SiCard5: 'SI5',
      SiCard6: 'SI6',
      SiCard8: 'SI8',
      SiCard9: 'SI9',
      SiCard10: 'SI10',
      SiCard11: 'SI11',
      SIAC: 'SIAC',
    };
    emitter.card_inserted({
      card_type: TYPE_MAP[typeName] ?? 'SI5',
      card_number: card.cardNumber,
      ...(card.cardSeriesByte !== undefined ? { card_series_byte: card.cardSeriesByte } : {}),
    });
  });
  station.on('cardRead', (card: BaseSiCard) => emitter.card_read({ card }));
  station.on('cardRemoved', (cardNumber: number) =>
    emitter.card_removed({ card_number: cardNumber })
  );
  station.on('frameError', (err: FrameError) => emitter.frame_error(err));

  await transport.open();
  await station.readCards();
  await transport.pumpRemaining();
  await new Promise((r) => setTimeout(r, 80));
  await station.close();

  const replayError = transport.getError();
  assert.strictEqual(replayError, null, `transport error: ${replayError ?? ''}`);
  return captured.map((l) => l.replace(/\n$/, ''));
};

const wireEvents = (lines: string[]): string[] =>
  lines.map(normaliseTs).filter((l) => !/"event":"connection_changed"/.test(l));

describe('bench-fixture replay (BSM7-USB 2026-05-13, serial BSM 2026-10-03)', () => {
  for (const { slug, expectedType } of CARDS) {
    test(`${slug}-bench-001 wire-event NDJSON matches bench truth`, async () => {
      const basename = path.join(FIXTURE_DIR, `${slug}-bench-001`);

      const actualLines = await captureBenchReplay(basename);
      const expectedRaw = fs.readFileSync(`${basename}.expected.json`, 'utf8');
      const expectedLines = expectedRaw.split('\n').filter((l) => l.length > 0);

      const actualWire = wireEvents(actualLines);
      const expectedWire = wireEvents(expectedLines);

      // Sanity: every bench fixture must contain a card_inserted + card_read pair
      // with the expected card_type. Real captures may legitimately include leading
      // card_removed events (operator clears a card before inserting the fresh one),
      // so we locate card_inserted by predicate rather than pinning its index.
      const insertedIdx = expectedWire.findIndex((l) => l.includes(`"event":"card_inserted"`));
      assert.notStrictEqual(insertedIdx, -1, 'fixture has a card_inserted event');
      assert.ok(
        expectedWire[insertedIdx]!.includes(`"card_type":"${expectedType}"`),
        `card_inserted carries card_type=${expectedType}`
      );
      assert.ok(
        expectedWire.slice(insertedIdx + 1).some((l) => l.includes(`"event":"card_read"`)),
        'card_read follows card_inserted'
      );

      assert.deepStrictEqual(actualWire, expectedWire);
    });
  }
});
