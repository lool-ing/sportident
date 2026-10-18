// Authored for lool. Not ported from upstream.
//
// `replayFixture(basename)` — reads a directional transcript (`<basename>
// .bytes.hex`) and drives SiMainStation via a deterministic
// playback transport that gates `in <hex>` chunks on the corresponding `out
// <hex>` chunk being delivered by the station. Compares produced NDJSON to
// `<basename>.expected.json` (ts_ms normalised to 0) and returns
// `{matches, diff?}`.
//
// Ordering discipline: every `in` is pumped on its own event-loop tick to give
// the multiplexer's parseAll a chance to fully process each chunk before the
// next arrives. The first `in` after each `out` is the immediate response;
// subsequent consecutive `in` lines are SPONTANEOUS (e.g., SI*_DET frames the
// station emits between handshake steps) and are delayed slightly so the
// current `sendMessage()` promise resolves first.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { SiMainStation } from '../SiStation/SiMainStation.ts';
import { NdjsonEmitter } from '../output/ndjson.ts';
import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import { inferCardType } from '../SiCard/cardTypeFromNumber.ts';
import { render, type FrameError } from '../siProtocol.ts';

export interface ReplayResult {
  matches: boolean;
  diff?: string;
}

export interface ReplayFixtureOpts {
  /** Roots under which `basename` is permitted to resolve. Default:
   * `[process.cwd()]`. Tests pass `[process.cwd(), '/tmp']`. */
  allowedRoots?: string[];
}

type Direction = 'out' | 'in';
interface TranscriptStep {
  dir: Direction;
  bytes: number[];
}

interface TranscriptMeta {
  device_path: string;
  device_serial: string | undefined;
}

const validateBasename = (basename: string, allowedRoots: string[]): string => {
  const resolved = path.resolve(basename);
  const roots = allowedRoots.map((r) => path.resolve(r));
  const ok = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) {
    throw new Error(
      `basename resolves outside allowed roots: ${resolved} (allowed: ${roots.join(', ')})`
    );
  }
  return resolved;
};

const hexEncode = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

const parseTranscript = (raw: string): { steps: TranscriptStep[]; meta: TranscriptMeta } => {
  const steps: TranscriptStep[] = [];
  const meta: TranscriptMeta = { device_path: '/dev/replay', device_serial: undefined };
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) {
      const capm = /^#\s*Captured\s+\S+\s+from\s+(\S+)/.exec(line);
      if (capm) meta.device_path = capm[1]!;
      const sm = /^#\s*device_serial:\s*(\S+)/.exec(line);
      if (sm && sm[1] !== 'unknown') meta.device_serial = sm[1]!;
      continue;
    }
    const m = /^(out|in)\s+([0-9A-Fa-f \t]+)$/.exec(line);
    if (!m) throw new Error(`bad transcript line: ${JSON.stringify(line)}`);
    const dir = m[1] as Direction;
    const bytes = m[2]!
      .split(/\s+/)
      .filter((s) => s.length > 0)
      .map((s) => parseInt(s, 16));
    steps.push({ dir, bytes });
  }
  return { steps, meta };
};

/**
 * Reply for a GET_SI8 page-1 or page-3 request that a transcript does not
 * contain. Bench captures made before block-1 and block-3 support
 * (siac-bench-001: touch-free finish, blocks 1 and 3 never read) are frozen
 * truth, so they stay strict; these extra requests are answered with an
 * erased page (all 0xEE, "no data"): no block-1 code, battery or versions. Undefined for any other request.
 * The erased page 3 makes the reserve records read and empty (`start_first` /
 * `finish_first` null in siac-bench-001.expected.json), although the bench
 * read never fetched block 3; no reply on the wire can say "not read".
 */
export const legacyErasedPageReply = (sent: number[]): number[] | undefined => {
  for (const page of [0x01, 0x03]) {
    const request = [0xff, ...render({ command: 0xef, parameters: [page] })];
    if (hexEncode(sent) !== hexEncode(request)) continue;
    return render({
      command: 0xef,
      parameters: [0x00, 0x0a, page, ...new Array<number>(128).fill(0xee)],
    });
  }
  return undefined;
};

/**
 * Playback transport: gated by SiMainStation's send order.
 *   - On send(): assert next step is `out` with matching bytes; advance cursor.
 *     Pump the FIRST following `in` immediately (it's the response). Spontaneous
 *     `in` lines (any consecutive after the first) are scheduled with a small
 *     delay so the current send-cycle resolves first.
 *   - Mismatch is captured in `error` and surfaced to replayFixture as diff.
 */
class PlaybackTransport extends EventEmitter implements ISerialTransport {
  private cursor = 0;
  private error: string | null = null;
  private steps: TranscriptStep[];

  constructor(steps: TranscriptStep[]) {
    super();
    this.steps = steps;
  }

  open(): Promise<void> {
    return Promise.resolve();
  }

  send(bytes: number[]): Promise<void> {
    if (this.error) return Promise.reject(new Error(this.error));
    // the production pipeline sends a bare ACK (0x06)
    // after every successful card read. Pre-fixtures don't contain
    // the trailing `out 06`; tolerate that case by silently absorbing the
    // ACK send when the transcript doesn't expect one at the cursor. When
    // the fixture DOES expect the ACK (post-captures), fall through
    // to the normal cursor-advance path so the assertion still fires.
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
    }
    const step = this.steps[this.cursor];
    const legacy = legacyErasedPageReply(bytes);
    if (
      legacy !== undefined &&
      (step === undefined || hexEncode(step.bytes) !== hexEncode(bytes))
    ) {
      setImmediate(() => this.emit('data', legacy));
      return Promise.resolve();
    }
    if (!step) {
      this.error = `out mismatch: transcript exhausted (sent ${hexEncode(bytes)})`;
      return Promise.reject(new Error(this.error));
    }
    if (step.dir !== 'out') {
      this.error = `out mismatch: expected 'in' but station sent ${hexEncode(bytes)} (cursor=${this.cursor})`;
      return Promise.reject(new Error(this.error));
    }
    const expected = hexEncode(step.bytes);
    const actual = hexEncode(bytes);
    if (expected !== actual) {
      this.error = `out mismatch at step ${this.cursor}: expected '${expected}', got '${actual}'`;
      return Promise.reject(new Error(this.error));
    }
    this.cursor++;
    // Pump every consecutive `in` chunk that follows this `out` and precedes
    // the next `out`. The real serial driver fragments single logical wire
    // frames across multiple MTU-sized `in` reads, so an `out GET_SYS_VAL`
    // can be followed by 3 `in` lines that parseAll reassembles into one
    // frame. Subsequent consecutive `in` lines (e.g. a spontaneous SI*_DET
    // arriving between handshake completion and the next station command)
    // are emitted in the same batch — parseAll handles them in order via
    // its internal byte buffer.
    //
    // Each chunk gets its own setImmediate tick so parseAll runs once per
    // chunk and the station's send-promise chain resolves between bursts.
    const inChunks: number[][] = [];
    while (this.cursor < this.steps.length) {
      const next = this.steps[this.cursor];
      if (!next || next.dir !== 'in') break;
      inChunks.push(next.bytes);
      this.cursor++;
    }
    // Emit each chunk on its own tick so parseAll processes them in order.
    for (const chunk of inChunks) {
      setImmediate(() => this.emit('data', chunk));
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    setImmediate(() => this.emit('close'));
    return Promise.resolve();
  }

  /** Pump every remaining `in` step on a delayed schedule (one per tick),
   * spacing them so each gets a clean parseAll cycle. Called after handshake
   * resolves so spontaneous SI*_DET frames are processed in order, without
   * racing the connectionChanged:'open' emission. */
  pumpRemaining(perTickDelayMs: number = 5): Promise<void> {
    return new Promise<void>((resolve) => {
      const tick = (): void => {
        const step = this.steps[this.cursor];
        if (!step) {
          resolve();
          return;
        }
        if (step.dir === 'out') {
          // The next out will arrive via send(). We can't fabricate it.
          resolve();
          return;
        }
        this.cursor++;
        setImmediate(() => this.emit('data', step.bytes));
        setTimeout(tick, perTickDelayMs);
      };
      setTimeout(tick, perTickDelayMs);
    });
  }

  getError(): string | null {
    return this.error;
  }

  isExhausted(): boolean {
    return this.cursor >= this.steps.length;
  }

  /** The first request the transcript still expects but never got, if any. */
  unsentOut(): string | null {
    const step = this.steps.slice(this.cursor).find((s) => s.dir === 'out');
    return step ? hexEncode(step.bytes) : null;
  }
}

/** Normalise ts_ms to 0 on a single NDJSON line so the diff isn't dominated by
 * Date.now() drift between record and replay. */
const normaliseLine = (line: string): string => {
  if (line.length === 0) return line;
  const obj = JSON.parse(line) as Record<string, unknown>;
  obj.ts_ms = 0;
  return JSON.stringify(obj);
};

const buildDiff = (expected: string[], actual: string[]): string => {
  const out: string[] = [];
  const max = Math.max(expected.length, actual.length);
  for (let i = 0; i < max; i++) {
    const e = expected[i] ?? '<missing>';
    const a = actual[i] ?? '<missing>';
    if (e !== a) {
      out.push(`@@ line ${i + 1} @@`);
      out.push(`- ${e}`);
      out.push(`+ ${a}`);
    }
  }
  return out.join('\n');
};

export const replayFixture = async (
  basename: string,
  opts: ReplayFixtureOpts = {}
): Promise<ReplayResult> => {
  const allowedRoots = opts.allowedRoots ?? [process.cwd()];
  const resolved = validateBasename(basename, allowedRoots);

  const bytesRaw = fs.readFileSync(`${resolved}.bytes.hex`, 'utf8');
  const expectedRaw = fs.readFileSync(`${resolved}.expected.json`, 'utf8');

  const { steps, meta } = parseTranscript(bytesRaw);
  const transport = new PlaybackTransport(steps);

  const captured: string[] = [];
  const emitterOpts: { device_path: string; device_serial?: string; out: (line: string) => void } =
    {
      device_path: meta.device_path,
      out: (line) => captured.push(line),
    };
  if (meta.device_serial !== undefined) emitterOpts.device_serial = meta.device_serial;
  const emitter = new NdjsonEmitter(emitterOpts);

  const station = new SiMainStation(transport);
  station.on('connectionChanged', (state: 'opening' | 'open' | 'closed' | 'error') =>
    emitter.connection_changed({ state })
  );
  // use the shared inferCardType(cardNumber) helper so
  // the card_type field of card_inserted matches what the bin emits during
  // --record. Previously hard-coded 'SI5' here, which made replay diverge
  // from record for SI9 / SI10 / SIAC cards.
  station.on('cardInserted', (card: BaseSiCard) =>
    emitter.card_inserted({
      card_type: inferCardType(card.cardNumber),
      card_number: card.cardNumber,
      ...(card.cardSeriesByte !== undefined ? { card_series_byte: card.cardSeriesByte } : {}),
    })
  );
  station.on('cardRead', (card: BaseSiCard) => emitter.card_read({ card }));
  station.on('cardRemoved', (cardNumber: number) =>
    emitter.card_removed({ card_number: cardNumber })
  );
  station.on('frameError', (err: FrameError) => emitter.frame_error(err));

  // mirror lool-readout.ts's lifecycle. The bin emits
  // a manual connection_changed/opening BEFORE transport.open(), then
  // SiMainStation.readCards() emits another opening followed by open. The
  // recorded .expected.json fixtures therefore contain two consecutive
  // 'opening' events; the previous replay path only emitted one (from inside
  // readCards) and diverged from record by one line.
  emitter.connection_changed({ state: 'opening' });

  // Drive the handshake; this consumes the leading `out`/`in` steps.
  try {
    await transport.open();
    await station.readCards();
  } catch (err) {
    const msg = transport.getError() ?? (err instanceof Error ? err.message : String(err));
    return { matches: false, diff: msg };
  }

  // Now pump any remaining spontaneous `in` lines (e.g., SI*_DET frames the
  // station injects between handshake response and the next out). Each tick
  // emits one `in`, gives parseAll a clean cycle, then schedules the next.
  // When the cursor reaches an `out`, send() will run again from the station
  // (the card-read GET_SI5/GET_SI8 follow-up). pumpRemaining resolves either
  // when the cursor hits an `out` or runs out.
  await transport.pumpRemaining();

  // Let the post-pump events (card_read after GET_SI5 returns) settle.
  await new Promise((r) => setTimeout(r, 80));

  await station.close();

  const replayError = transport.getError();
  if (replayError) {
    return { matches: false, diff: replayError };
  }
  const unsent = transport.unsentOut();
  if (unsent !== null) {
    return { matches: false, diff: `out never sent: transcript expects '${unsent}'` };
  }

  // Compare with ts_ms normalised.
  const expectedLines = expectedRaw
    .split('\n')
    .filter((l) => l.length > 0)
    .map(normaliseLine);
  const actualLines = captured.map((l) => l.replace(/\n$/, '')).map(normaliseLine);

  if (
    expectedLines.length === actualLines.length &&
    expectedLines.every((l, i) => l === actualLines[i])
  ) {
    return { matches: true };
  }
  return { matches: false, diff: buildDiff(expectedLines, actualLines) };
};
