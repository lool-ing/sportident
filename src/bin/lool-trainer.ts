#!/usr/bin/env node
// Authored for lool. Not ported from upstream.
//
// Phase 0.2 — continuous-readout trainer for bench rehearsal before Phase 1.
// Reuses the lool-readout pipeline (SerialTransport + SiMainStation +
// NdjsonEmitter) but adds two event-flow behaviours the readout bin doesn't
// have:
//
//   1. Course validation. Every card_read is compared against an --course
//      sequence (in-order subsequence match per real orienteering rules:
//      extras between expected controls are fine, missing or wrong-order
//      is MP). A one-line result is printed to stderr per card.
//
//   2. Continuous loop. No --once, no Enter prompt between cards. Card
//      removed → reader is immediately ready for the next card. This is
//      what a real readout secretariat feels like during an event.
//
// stdout stays NDJSON so the trainer can still be piped into downstream
// tooling (live results UI, IOF XML exporter, etc.) when Phase 1 lands.

import { SerialTransport } from '../transport/SerialTransport.ts';
import { SiMainStation } from '../SiStation/SiMainStation.ts';
import { NdjsonEmitter } from '../output/ndjson.ts';
import { emitDiagnostic } from '../output/diagnostics.ts';
import type { FrameError } from '../siProtocol.ts';
import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import { inferCardType } from '../SiCard/cardTypeFromNumber.ts';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export interface TrainerOpts {
  device: string;
  course: number[];
  bell: boolean;
  requireStart: boolean;
  requireFinish: boolean;
}

const DEFAULT_COURSE = [136, 110] as const;

const HELP = `lool-trainer: continuous-readout with course validation.

Usage:
  lool-trainer [options]

Options:
  --device <path>          Serial device (overrides $LOOL_DEVICE, default /dev/ttyUSB0)
  --course <codes>         Comma-separated control codes in order (default: ${DEFAULT_COURSE.join(',')})
  --bell                   Ring the terminal bell on MP (helpful when running blind)
  --require-start          Require a start punch on the card (open classes / kids).
                           Default OFF — most classes get start time from a start list,
                           not from a start-station punch.
  --no-finish              Skip the "card must have a finish punch" check (testing/debug)
  --help, -h               Show this help.

Behaviour:
  Loops forever until SIGINT. For every card read, prints a one-line result
  to stderr (✓ OK or ✗ MP) and emits the standard NDJSON event sequence to
  stdout. Card removed → reader is immediately ready for the next card.

Course matching is LENIENT (real orienteering rules): the expected codes
must appear in order in the punch sequence, but extra punches between are
fine. Missing a code, or punching them out of order, is MP.
`;

export const parseTrainerArgs = (argv: string[]): TrainerOpts => {
  const opts: TrainerOpts = {
    device: process.env.LOOL_DEVICE ?? '/dev/ttyUSB0',
    course: [...DEFAULT_COURSE],
    bell: false,
    requireStart: false,
    requireFinish: true,
  };
  const valueFor = (
    flag: string,
    raw: string,
    index: number
  ): { value: string; consumed: number } => {
    if (raw.startsWith(`${flag}=`)) {
      const value = raw.slice(flag.length + 1);
      if (value.length === 0) throw new Error(`${flag} requires a value`);
      return { value, consumed: 0 };
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('-')) throw new Error(`${flag} requires a value`);
    return { value: next, consumed: 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--device' || a.startsWith('--device=')) {
      const { value, consumed } = valueFor('--device', a, i);
      opts.device = value;
      i += consumed;
    } else if (a === '--course' || a.startsWith('--course=')) {
      const { value, consumed } = valueFor('--course', a, i);
      const codes = value.split(',').map((s) => Number(s.trim()));
      if (codes.some((c) => !Number.isInteger(c) || c < 0))
        throw new Error(`--course must be comma-separated non-negative integers (got: ${value})`);
      if (codes.length === 0) throw new Error('--course must include at least one code');
      opts.course = codes;
      i += consumed;
    } else if (a === '--bell') {
      opts.bell = true;
    } else if (a === '--require-start') {
      opts.requireStart = true;
    } else if (a === '--no-finish') {
      opts.requireFinish = false;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
};

export interface MatchResult {
  ok: boolean;
  reason?: 'wrong_order' | 'missing_control' | 'no_punches' | 'missing_start' | 'missing_finish';
  missingCode?: number;
}

export interface CardSummary {
  punches: number[];
  hasStart: boolean;
  hasFinish: boolean;
}

// Project a card's race-result data down to the shape matchCourse needs.
// Loose != null check: the SI card decoder sets startTime/finishTime to null
// (not undefined) when the runner skipped the corresponding station, and a
// strict !== undefined check would miss that — see bench 2026-05-14.
export const toCardSummary = (raceResult: {
  punches?: { code: number }[];
  startTime?: unknown;
  finishTime?: unknown;
}): CardSummary => ({
  punches: (raceResult.punches ?? []).map((p) => p.code),
  hasStart: raceResult.startTime != null,
  hasFinish: raceResult.finishTime != null,
});

// Lenient subsequence match: every code in `course` must appear in `punches`
// in order, extras between are allowed. Plus optional gates on start + finish
// punches (real orienteering rules — runner must touch the start station and
// the finish station; missing either is MP regardless of intermediate punches).
export const matchCourse = (
  card: CardSummary,
  course: number[],
  opts: { requireStart?: boolean; requireFinish?: boolean } = {}
): MatchResult => {
  // Defaults match real orienteering: most classes get start time from a start
  // list (no start punch needed), but every class must have a finish punch.
  const requireStart = opts.requireStart ?? false;
  const requireFinish = opts.requireFinish ?? true;

  if (requireStart && !card.hasStart) return { ok: false, reason: 'missing_start' };

  if (course.length > 0) {
    if (card.punches.length === 0) return { ok: false, reason: 'no_punches' };
    let courseIdx = 0;
    for (const punch of card.punches) {
      if (punch === course[courseIdx]) courseIdx++;
      if (courseIdx === course.length) break;
    }
    if (courseIdx < course.length) {
      const missingCode = course[courseIdx] as number;
      const reason = card.punches.includes(missingCode) ? 'wrong_order' : 'missing_control';
      return { ok: false, reason, missingCode };
    }
  }

  if (requireFinish && !card.hasFinish) return { ok: false, reason: 'missing_finish' };

  return { ok: true };
};

// ANSI colour helpers — only emit when stderr is a TTY so piping stays clean.
const useColor = process.stderr.isTTY;
const green = (s: string): string => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string): string => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

const formatResult = (
  cardNumber: number,
  punches: number[],
  course: number[],
  result: MatchResult
): string => {
  const cardLabel = `card ${cardNumber}`.padEnd(14);
  if (result.ok) {
    const sequence = course.join(' → ');
    return `${green('✓ OK')}    ${cardLabel}  ${sequence}`;
  }
  const punchList = punches.length === 0 ? '(no punches)' : punches.join(', ');
  const expected = course.join(' → ');
  if (result.reason === 'missing_start') {
    return `${red('✗ MP')}    ${cardLabel}  no start punch (open class requires start station)`;
  }
  if (result.reason === 'missing_finish') {
    return `${red('✗ MP')}    ${cardLabel}  no finish punch (mål missing)`;
  }
  if (result.reason === 'wrong_order') {
    return `${red('✗ MP')}    ${cardLabel}  expected ${expected}, got [${punchList}]   ${dim('(wrong order)')}`;
  }
  if (result.reason === 'missing_control') {
    return `${red('✗ MP')}    ${cardLabel}  missing ${result.missingCode}, got [${punchList}]`;
  }
  return `${red('✗ MP')}    ${cardLabel}  no punches read`;
};

const main = async (): Promise<void> => {
  const opts = parseTrainerArgs(process.argv.slice(2));

  const emitter = new NdjsonEmitter({ device_path: opts.device });
  emitter.connection_changed({ state: 'opening' });

  const transport = new SerialTransport({ path: opts.device, baudRate: 38400 });
  const station = new SiMainStation(transport);

  const courseStr = opts.course.join(' → ');
  process.stderr.write(
    `${dim(`lool-trainer  course: ${courseStr}  device: ${opts.device}  (Ctrl-C to quit)`)}\n\n`
  );

  station.on('cardInserted', (card: BaseSiCard) => {
    emitter.card_inserted({
      card_type: inferCardType(card.cardNumber),
      card_number: card.cardNumber,
      ...(card.cardSeriesByte !== undefined ? { card_series_byte: card.cardSeriesByte } : {}),
    });
  });

  station.on('cardRead', (card: BaseSiCard) => {
    emitter.card_read({ card });
    const cardSummary = toCardSummary(card.raceResult);
    const result = matchCourse(cardSummary, opts.course, {
      requireStart: opts.requireStart,
      requireFinish: opts.requireFinish,
    });
    process.stderr.write(
      `${formatResult(card.cardNumber, cardSummary.punches, opts.course, result)}\n`
    );
    if (!result.ok && opts.bell) process.stderr.write('\x07');
  });

  station.on('cardRemoved', (cardNumber: number) =>
    emitter.card_removed({ card_number: cardNumber })
  );

  station.on('frameError', (err: FrameError) => {
    emitter.frame_error(err);
    emitDiagnostic(`frame_error: ${err.error_code} (${err.bytes_consumed} bytes consumed)`);
  });

  // Report and keep going; serialport errors come through the transport.
  const report = (err: Error): void => {
    emitter.connection_changed({ state: 'error', error: err.message });
    emitDiagnostic(`station error: ${err.message}`);
  };
  station.on('error', report);
  transport.on('error', report);

  await transport.open();
  emitter.connection_changed({ state: 'open' });
  await station.readCards();

  // Wire SIGINT to clean shutdown — closes the station + transport so the
  // BSM7 stops emitting before we exit, and the next session opens cleanly.
  const shutdown = async (): Promise<void> => {
    try {
      await station.close();
    } catch {
      /* swallow — exiting anyway */
    }
    emitter.connection_changed({ state: 'closed' });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Keep the event loop alive — main() should never resolve.
  await new Promise<void>(() => {});
};

// Entrypoint detection that works in both bundle formats. In the ESM bundle,
// `import.meta.url` is the resolved file URL. In the CJS bundle, tsup polyfills
// `import.meta` to `{}` (so `.url` is undefined and `fileURLToPath` throws);
// the CJS-native check `require.main === module` is the canonical signal there.
const isEntrypoint = ((): boolean => {
  if (!process.argv[1]) return false;
  // CJS bundle: tsup injects `require`/`module` per node's module wrapper.
  // `require.main === module` is the canonical entry signal in CJS.
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    return true;
  }
  // ESM bundle: compare resolved file paths.
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntrypoint)
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const emitter = new NdjsonEmitter({
        device_path: process.env.LOOL_DEVICE ?? '/dev/ttyUSB0',
      });
      emitter.connection_changed({ state: 'error', error: message });
    } catch {
      /* ignore secondary failure */
    }
    emitDiagnostic(`fatal: ${err instanceof Error ? (err.stack ?? message) : message}`);
    process.exit(1);
  });
