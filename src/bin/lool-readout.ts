#!/usr/bin/env node
// Authored for lool. Not ported from upstream.
//
// Public entry point — `lool-readout`. Opens a SerialTransport against the
// device path (`--device <path>`, env var `LOOL_DEVICE`, default
// `/dev/ttyUSB0`), drives SiMainStation through the handshake, and pipes the
// 5 station events into NdjsonEmitter on stdout (NDJSON, schema_version=1)
// plus one-line human diagnostics on stderr.
//
// the `frameError` handler accepts the typed FrameError
// directly from siProtocol and forwards it to `emitter.frame_error`. No
// stdout-warning interception or string parsing anywhere in the call graph.
//
// `--record <basename>` swaps NdjsonEmitter for RecordSink which tees
// the NDJSON to `<basename>.expected.json` AND captures a directional wire
// transcript (`out <hex>` / `in <hex>` lines) to `<basename>.bytes.hex`. `--replay <basename>` drives the same pipeline against a
// playback transport seeded by the transcript (no hardware). `--once` exits
// after a single cardRead — used by `scripts/hardware-smoke.sh` so each card
// type lands a fresh fixture pair.
//
// Real-hardware execution happens in the smoke script, which spawns this
// bin against /dev/ttyUSB0. Tests use FakeSerialTransport at the SiMainStation
// layer (src/SiStation/SiMainStation.test.ts, src/integration/e2e.test.ts).
//
// See NOTICE.md for cumulative attribution.

import { SerialTransport } from '../transport/SerialTransport.ts';
import { SiMainStation } from '../SiStation/SiMainStation.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { DeviceClosedError } from '../transport/errors.ts';
import { NdjsonEmitter } from '../output/ndjson.ts';
import { emitDiagnostic } from '../output/diagnostics.ts';
import { formatEvent } from '../output/pretty.ts';
import type { FrameError } from '../siProtocol.ts';
import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import { inferCardType } from '../SiCard/cardTypeFromNumber.ts';
import { initialBaud, parseBaud, readCardsAtBaud, type Baud } from './baud.ts';
import { RecordSink } from './record.ts';
import { replayFixture } from './replay.ts';

// ---------------------------------------------------------------------------
// CLI arg parsing — minimal hand-rolled (no commander/yargs dep). Flags:
//   --device <path>          Serial device (overrides $LOOL_DEVICE)
//   --baud <38400|4800|auto> Serial rate (overrides $LOOL_BAUD, default 38400)
//   --once                   Read one card then exit
//   --include-raw-pages      Include raw_pages_b64 in card_read events
//   --pretty                 Human-readable punch table instead of NDJSON
//   --record <basename>      Tee NDJSON + directional wire transcript to disk.
//                            Allowed roots: cwd OR /tmp.
//   --replay <basename>      Drive SiMainStation against the transcript and
//                            assert byte-equal NDJSON output.
// ---------------------------------------------------------------------------

export interface CliOpts {
  device: string;
  baud: Baud;
  once: boolean;
  includeRawPages: boolean;
  pretty: boolean;
  record?: string;
  replay?: string;
}

const HELP = `lool-readout: stream SportIdent card reads as NDJSON.

Usage:
  lool-readout [options]

Options:
  --device <path>          Serial device (overrides $LOOL_DEVICE, default /dev/ttyUSB0)
  --baud <38400|4800|auto> Serial rate (overrides $LOOL_BAUD, default 38400). Some
                           stations only answer at 4800; auto tries 38400, then 4800
  --once                   Read a single card then exit cleanly
  --include-raw-pages      Include raw_pages_b64 in card_read events
  --pretty                 Print a human-readable punch table instead of NDJSON
                           (ignored with --record and --replay)
  --record <basename>      Tee NDJSON to <basename>.expected.json AND capture
                           a directional wire transcript ('out <hex>' / 'in <hex>'
                           lines) to <basename>.bytes.hex. Allowed roots: the
                           current working directory OR /tmp.
  --replay <basename>      Drive the readout pipeline against the recorded
                           transcript at <basename>.bytes.hex and assert the
                           produced NDJSON matches <basename>.expected.json.
                           Exits 0 on match, 1 on diff.
  --help, -h               Show this help.

Exit codes:
  0   Clean shutdown (SIGINT, --once after a successful card read, or
      --replay match).
  1   Fatal initialisation failure (bad --device, unknown arg, replay diff).
  3   The device closed during a card read. A structured
      connection_changed/error NDJSON event is emitted before exit. Other
      card-read errors emit that event and readout goes on.
`;

export const parseArgs = (argv: string[]): CliOpts => {
  const opts: CliOpts = {
    device: process.env.LOOL_DEVICE ?? '/dev/ttyUSB0',
    baud: 38400,
    once: false,
    includeRawPages: false,
    pretty: false,
  };
  // Helper: pull the value for a `--flag` argument. Accepts either the
  // following positional token (`--flag value`) OR an inline `--flag=value`
  // pair. Rejects a missing or flag-looking value so `--device --once` doesn't
  // silently absorb `--once` as the device path.
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

  // Parsed after the loop: --help still works and --baud overrides a bad $LOOL_BAUD.
  let baudArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--device' || a.startsWith('--device=')) {
      const { value, consumed } = valueFor('--device', a, i);
      opts.device = value;
      i += consumed;
    } else if (a === '--baud' || a.startsWith('--baud=')) {
      const { value, consumed } = valueFor('--baud', a, i);
      baudArg = value;
      i += consumed;
    } else if (a === '--once') {
      opts.once = true;
    } else if (a === '--include-raw-pages') {
      opts.includeRawPages = true;
    } else if (a === '--pretty') {
      opts.pretty = true;
    } else if (a === '--record' || a.startsWith('--record=')) {
      const { value, consumed } = valueFor('--record', a, i);
      opts.record = value;
      i += consumed;
    } else if (a === '--replay' || a.startsWith('--replay=')) {
      const { value, consumed } = valueFor('--replay', a, i);
      opts.replay = value;
      i += consumed;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  opts.baud = parseBaud(baudArg ?? process.env.LOOL_BAUD ?? '38400');
  return opts;
};

const formatCrcHex = (pair: [number, number] | undefined): string => {
  if (!pair) return '?';
  return (
    pair[0].toString(16).padStart(2, '0').toUpperCase() +
    pair[1].toString(16).padStart(2, '0').toUpperCase()
  );
};

const runReplay = async (basename: string): Promise<void> => {
  // Replay never touches the serial port — drive replayFixture and exit.
  // Allowed roots: cwd + /tmp so smoke-script-derived
  // fixtures committed to tests/fixtures/bench/ AND
  // temporary fixtures in /tmp both work.
  const result = await replayFixture(basename, { allowedRoots: [process.cwd(), '/tmp'] });
  if (result.matches) {
    emitDiagnostic(`replay match: ${basename}`);
    process.exit(0);
  }
  emitDiagnostic(`replay mismatch: ${basename}\n${result.diff ?? ''}`);
  process.exit(1);
};

/**
 * Wire the station's and transport's events to the NDJSON emitter. Exported
 * for tests; `shutdown` is the only way out of the process.
 */
export const wireReadout = (
  station: SiMainStation,
  transport: ISerialTransport,
  emitter: NdjsonEmitter,
  opts: Pick<CliOpts, 'once'>,
  shutdown: (code: number) => Promise<void>
): void => {
  // Wire all five events. The frameError handler receives
  // the typed FrameError directly — NO string parsing of warning lines.
  //
  // card_inserted card_type uses the shared
  // inferCardType(cardNumber) helper so the bin (record path) and
  // replayFixture (replay path) agree. The constructor.name → CardType map
  // (TYPE_MAP) stays in place for card_read in NdjsonEmitter where the card
  // instance carries richer state that drives extra fields — it's only the
  // card_inserted event where range-based inference and constructor.name
  // ever disagreed pre-fix.
  station.on('cardInserted', (card: BaseSiCard) => {
    emitter.card_inserted({
      card_type: inferCardType(card.cardNumber),
      card_number: card.cardNumber,
      ...(card.cardSeriesByte !== undefined ? { card_series_byte: card.cardSeriesByte } : {}),
    });
  });
  station.on('cardRead', (card: BaseSiCard) => {
    emitter.card_read({ card });
    if (opts.once) {
      void shutdown(0);
    }
  });
  station.on('cardRemoved', (cardNumber: number) =>
    emitter.card_removed({ card_number: cardNumber })
  );
  station.on('frameError', (err: FrameError) => {
    emitter.frame_error(err);
    emitDiagnostic(
      `frame_error ${err.error_code}: expected ${formatCrcHex(err.expected_crc)}, got ${formatCrcHex(err.actual_crc)} (${err.bytes_consumed} bytes consumed)`
    );
  });
  station.on(
    'connectionChanged',
    (state: 'opening' | 'open' | 'closed' | 'error', err?: { message?: string }) => {
      emitter.connection_changed({
        state,
        ...(err?.message ? { error: err.message } : {}),
      });
    }
  );

  // SiMainStation emits Node's special 'error' event when a card read fails
  // (eg the card was pulled mid-read); SerialTransport re-emits serialport
  // errors the same way. Without a listener the EventEmitter rule turns either
  // into a process crash. Report it (NDJSON `connection_changed/error` + a
  // stderr diagnostic) and keep reading: one bad card must not end readout.
  // Only a transport close mid-read exits (code 3).
  const report = (label: string) => (err: Error) => {
    const message = err instanceof Error ? err.message : String(err);
    try {
      emitter.connection_changed({ state: 'error', error: message });
    } catch {
      // ignore secondary failure
    }
    emitDiagnostic(`${label}: ${message}`);
    if (err instanceof DeviceClosedError) void shutdown(3);
  };
  station.on('error', report('card-read error'));
  transport.on('error', report('serial error'));
};

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));

  // --replay short-circuits — no serial port, no recording.
  if (opts.replay !== undefined) {
    await runReplay(opts.replay);
    return;
  }

  // Construct emitter (or RecordSink subclass when --record). RecordSink tees
  // stdout NDJSON to <basename>.expected.json AND opens the directional
  // wire-transcript stream <basename>.bytes.hex. Allowed roots: cwd + /tmp
  // The smoke script writes under cwd, tests under /tmp.
  const emitter: NdjsonEmitter =
    opts.record !== undefined
      ? new RecordSink({
          device_path: opts.device,
          recordBasename: opts.record,
          allowedRoots: [process.cwd(), '/tmp'],
          ...(opts.includeRawPages ? { includeRawPages: true } : {}),
        })
      : new NdjsonEmitter({
          device_path: opts.device,
          ...(opts.includeRawPages ? { includeRawPages: true } : {}),
          ...(opts.pretty
            ? { out: (line: string) => process.stdout.write(formatEvent(JSON.parse(line))) }
            : {}),
        });

  emitter.connection_changed({ state: 'opening' });

  const transport = new SerialTransport({ path: opts.device, baudRate: initialBaud(opts.baud) });

  // When recording, intercept BOTH transport pathways via a thin Proxy so the
  // sink sees every wire chunk in both directions. The proxy wraps `send`
  // (records the chunk first, then delegates) and leaves the rest of the
  // ISerialTransport surface intact via Reflect.get fallthrough.
  let activeTransport: typeof transport = transport;
  if (opts.record !== undefined) {
    const sink = emitter as RecordSink;
    transport.on('data', (bytes: number[]) => sink.onRawReceive(bytes));
    activeTransport = new Proxy(transport, {
      get(target, prop, receiver) {
        if (prop === 'send') {
          return (bytes: number[]): Promise<void> => {
            sink.onRawSend(bytes);
            return target.send(bytes);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  const station = new SiMainStation(activeTransport);

  // Centralised shutdown: closes station then sinks (flushing RecordSink) then exits.
  const shutdown = async (code: number): Promise<void> => {
    try {
      await station.close();
    } catch {
      // best-effort
    }
    if (opts.record !== undefined) {
      try {
        await (emitter as RecordSink).close();
      } catch {
        // best-effort
      }
    }
    process.exit(code);
  };

  wireReadout(station, transport, emitter, opts, shutdown);

  // SIGINT: close cleanly, exit 0.
  process.on('SIGINT', () => {
    void shutdown(0);
  });

  // Ensure piped stdout writes don't drop on
  // SIGTERM. Best-effort; the type cast accounts for the internal _handle.
  try {
    (
      process.stdout as unknown as { _handle?: { setBlocking?: (b: boolean) => void } }
    )._handle?.setBlocking?.(true);
  } catch {
    // best-effort; ignore
  }

  await transport.open();
  const baud = await readCardsAtBaud({
    transport,
    readCards: () => station.readCards(),
    path: opts.device,
    baud: opts.baud,
  });
  if (opts.baud === 'auto') emitDiagnostic(`station answered at ${baud} baud`);
  // Stay alive listening for cards until SIGINT or --once mode triggers exit
  // via cardRead handler.
};

// Only execute main() when this module is the entrypoint. Imported for tests
// (parseArgs.test.ts), the top-level code stays inert so we don't try to open
// /dev/ttyUSB0 from a unit-test runtime.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

// Entrypoint detection that works in both bundle formats. In the ESM bundle,
// `import.meta.url` is the resolved file URL. In the CJS bundle, tsup polyfills
// `import.meta` to `{}` (so `.url` is undefined and `fileURLToPath` throws);
// the CJS-native check `require.main === module` is the canonical signal there.
const isEntrypoint = ((): boolean => {
  if (!process.argv[1]) return false;
  // CJS bundle: tsup injects `require`/`module` per node's module wrapper.
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    return true;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntrypoint)
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // Emit a final stdout connection_changed/error + stderr diagnostic so both
    // pipelines see the fatal. Build the NdjsonEmitter on demand because the
    // failure may have happened before construction (e.g. invalid --device).
    try {
      const emitter = new NdjsonEmitter({
        device_path: process.env.LOOL_DEVICE ?? '/dev/ttyUSB0',
      });
      emitter.connection_changed({ state: 'error', error: message });
    } catch {
      // ignore secondary failure
    }
    emitDiagnostic(`fatal: ${err instanceof Error ? (err.stack ?? message) : message}`);
    process.exit(1);
  });
