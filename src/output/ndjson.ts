// Authored for lool. Not ported from upstream.
//
// NDJSON event emitter (output layer). Implements
// the stable v1 schema — six event types (connection_changed, card_inserted,
// card_read, card_removed, card_unsupported, frame_error), all keys snake_case, all host
// timestamps ms-epoch numbers, schema_version=1 locked on every event.
//
// Card-internal half-day clock fields stay raw `{seconds_in_half_day, half_day,
// weekday}` — Phase 0 emits
// the card's wire-format timestamp; Phase 1 reconstructs wall-clock against the
// event date.
//
// `frame_error` consumes the typed `FrameError` from
// siProtocol directly. No string parsing of stdout warning lines anywhere in
// the call graph; the hex encoding of expected_crc / actual_crc / raw_bytes is
// produced by this module from the typed [number, number] / number[] fields.
//
// Output discipline: we call `process.stdout.write`
// directly. Tests inject a capture function via `opts.out`.
//
// See NOTICE.md for cumulative attribution.

import type { FrameError } from '../siProtocol.ts';
import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import { SI_TIME_CUTOFF } from '../siProtocol.ts';

// ---------------------------------------------------------------------------
// Public event types (re-exported through src/index.ts for downstream consumers
// particularly the Phase 1 ingester which will JSON.parse these lines and
// type-narrow on the `event` discriminator).
// ---------------------------------------------------------------------------

export interface NdjsonBase {
  schema_version: 1;
  event: string;
  ts_ms: number;
  device_path: string;
  device_serial?: string;
}

export type CardType =
  'SI5' | 'SI6' | 'SI8' | 'SI9' | 'SI10' | 'SI11' | 'SIAC' | 'PCARD' | 'TCARD' | 'FCARD';

export type ConnectionState = 'opening' | 'open' | 'closed' | 'error';

export interface ConnectionChangedEvent extends NdjsonBase {
  event: 'connection_changed';
  state: ConnectionState;
  error?: string;
}

export interface CardInsertedEvent extends NdjsonBase {
  event: 'card_inserted';
  card_type: CardType;
  card_number: number;
  card_series_byte?: number;
}

/** Raw half-day clock field on a punch / start / finish / check. Never converted to ms-epoch here. */
export interface HalfDayClock {
  seconds_in_half_day: number;
  half_day: 0 | 1;
  weekday: number | null;
  /** Station code (CN) of the unit that stamped this time. Start, finish and
   * check on SI6 and newer only; absent otherwise. */
  code?: number;
  /** Subsecond of a start/finish time in 1/256 s (0-255): the record's PTD bit 7
   * was set, so its CN byte is TSS (SPORTident card data structure doc, provided
   * on request). Absent: no fraction (also always absent on check/clear/punches). */
  subsec_256?: number;
}

export interface NdjsonPunch {
  code: number;
  /** null (with `half_day`): the punch has a code but no valid time, eg SI5
   * slots 31-36 (code only) or a stored time out of range. */
  seconds_in_half_day: number | null;
  half_day: 0 | 1 | null;
  weekday: number | null;
}

export interface CardReadEvent extends NdjsonBase {
  event: 'card_read';
  card_type: CardType;
  card_number: number;
  card_series_byte?: number;
  uid?: number;
  start: HalfDayClock | null;
  finish: HalfDayClock | null;
  check: HalfDayClock | null;
  clear: HalfDayClock | null;
  punch_count: number;
  punches: NdjsonPunch[];
  card_holder: Record<string, unknown> | null;
  /** SIAC only (block 3): the FIRST start/finish punch after a clear (reserve
   * record), next to the last one in `start`/`finish`. Absent: not read (block 3
   * not read, or no reserve records); null: read and empty. `code` is absent
   * when the reserve record has a subsecond. Observation only. */
  start_first?: HalfDayClock | null;
  finish_first?: HalfDayClock | null;
  /** SIAC only (block 3): battery voltage in mV, versions "major.minor". */
  battery_mv?: number;
  hardware_version?: string;
  software_version?: string;
  /** SIAC only (block 3): battery date "YYYY-MM-DD", no time zone. */
  battery_date?: string;
  raw_pages_b64?: string;
}

export interface CardRemovedEvent extends NdjsonBase {
  event: 'card_removed';
  card_number: number;
}

export interface CardUnsupportedEvent extends NdjsonBase {
  event: 'card_unsupported';
  card_number: number;
  /** The detect command byte: 0xE5 (SI5_DET), 0xE6 (SI6_DET) or 0xE8 (SI8_DET). */
  detect_command: number;
  card_series_byte?: number;
}

export interface FrameErrorEvent extends NdjsonBase {
  event: 'frame_error';
  error_code: FrameError['error_code'];
  bytes_consumed: number;
  expected_crc_hex?: string;
  actual_crc_hex?: string;
  raw_bytes_hex: string;
}

export type NdjsonEvent =
  | ConnectionChangedEvent
  | CardInsertedEvent
  | CardReadEvent
  | CardRemovedEvent
  | CardUnsupportedEvent
  | FrameErrorEvent;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map a card instance's constructor name to its public card_type label. */
const TYPE_MAP: Record<string, CardType> = {
  SiCard5: 'SI5',
  SiCard6: 'SI6',
  SiCard8: 'SI8',
  SiCard9: 'SI9',
  SiCard10: 'SI10',
  SiCard11: 'SI11',
  SIAC: 'SIAC',
};

const toHexPair = (pair: [number, number] | undefined): string | undefined => {
  if (!pair) return undefined;
  return (
    pair[0].toString(16).padStart(2, '0').toUpperCase() +
    pair[1].toString(16).padStart(2, '0').toUpperCase()
  );
};

const toHexBytes = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

/** Convert a camelCase key to snake_case. Used at the NDJSON boundary to
 * normalise card_holder fields produced by the ported upstream decoder (which
 * carries upstream's camelCase names like `firstName`/`isComplete`) into the
 * snake_case shape the schema requires. Pure string transform — no object copy
 * cost beyond the rebuild. */
const camelToSnake = (s: string): string => s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

/** Re-key an object's top-level fields from camelCase to snake_case. Does NOT
 * recurse — the Phase 0 card_holder is a flat dict so one level suffices. */
const snakeCaseKeys = (obj: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    out[camelToSnake(k)] = obj[k];
  }
  return out;
};

/** Convert a raw SiTimestamp (number | null | undefined) into the half-day
 * clock object. SiTimestamp values are 0..86399 seconds since midnight; the
 * upper half (>= 43200, SI_TIME_CUTOFF) is "PM" -> half_day=1, the lower half
 * is AM -> half_day=0. Phase 0's wire format already normalises into this
 * range (see SiTime in siProtocol.ts), so no further math is required.
 *
 * Weekday is not present in the SiTimestamp scalar (upstream SiTime returns a
 * plain `number | null`), so this helper always emits `weekday: null`. The
 * weekday byte lives elsewhere in storage and is currently not exposed by the
 * Phase 0 decoders. Phase 1 will plumb it through when wall-clock
 * reconstruction becomes important.
 */
// Exported so other code can build the same half-day clock shape as the
// NDJSON wire format.
export const toHalfDayClock = (
  raw: number | null | undefined,
  code?: number | null,
  subsec256?: number
): HalfDayClock | null => {
  if (raw === null || raw === undefined) return null;
  const half_day = raw >= SI_TIME_CUTOFF ? 1 : 0;
  const seconds_in_half_day = half_day === 1 ? raw - SI_TIME_CUTOFF : raw;
  const clock: HalfDayClock = { seconds_in_half_day, half_day, weekday: null };
  // Only start/finish/check from SI6 and newer carry a station code.
  if (typeof code === 'number') clock.code = code;
  if (typeof subsec256 === 'number') clock.subsec_256 = subsec256;
  return clock;
};

// ---------------------------------------------------------------------------
// NdjsonEmitter
// ---------------------------------------------------------------------------

export interface NdjsonEmitterOpts {
  device_path: string;
  device_serial?: string;
  /** Output sink. Defaults to a bound `process.stdout.write`. Tests inject a
   * capture function. */
  out?: (line: string) => void;
  /** When true, `card_read` events include `raw_pages_b64` (the concatenated
   * storage buffer base64-encoded). The `--include-raw-pages` flag
   * toggles this. */
  includeRawPages?: boolean;
}

/** Emit NDJSON events to stdout. Constructor accepts `out` for test injection. */
export class NdjsonEmitter {
  private readonly device_path: string;
  private readonly device_serial: string | undefined;
  private readonly out: (line: string) => void;
  private readonly includeRawPages: boolean;

  constructor(opts: NdjsonEmitterOpts) {
    this.device_path = opts.device_path;
    this.device_serial = opts.device_serial;
    this.out = opts.out ?? ((line) => process.stdout.write(line));
    this.includeRawPages = opts.includeRawPages === true;
  }

  // -------------------------------------------------------------------------
  // Public event methods (each writes one JSON.parse-able line ending in '\n').
  // -------------------------------------------------------------------------

  connection_changed(payload: { state: ConnectionState; error?: string }): void {
    const event: ConnectionChangedEvent = {
      ...this._base('connection_changed'),
      state: payload.state,
    };
    if (payload.error !== undefined) event.error = payload.error;
    this._write(event);
  }

  card_inserted(payload: {
    card_type: CardType;
    card_number: number;
    card_series_byte?: number;
  }): void {
    const event: CardInsertedEvent = {
      ...this._base('card_inserted'),
      card_type: payload.card_type,
      card_number: payload.card_number,
    };
    if (payload.card_series_byte !== undefined) {
      event.card_series_byte = payload.card_series_byte;
    }
    this._write(event);
  }

  card_read(payload: { card: BaseSiCard }): void {
    const card = payload.card;
    const cardTypeKey = card.constructor.name;
    const card_type = TYPE_MAP[cardTypeKey] ?? (cardTypeKey.toUpperCase() as CardType);

    const raceResult = card.raceResult;
    // ModernSiCard / SiCard5 expose punch_count, uid, cardSeries on the instance.
    type WithCounts = BaseSiCard & {
      punchCount?: number;
      uid?: number;
    };
    const c = card as WithCounts;
    const punches = (raceResult.punches ?? []).map((p): NdjsonPunch => {
      const clock = toHalfDayClock(p.time);
      return {
        code: p.code,
        // A missing time stays null so a code-only punch differs from 00:00:00.
        seconds_in_half_day: clock?.seconds_in_half_day ?? null,
        half_day: clock?.half_day ?? null,
        weekday: clock?.weekday ?? null,
      };
    });
    const event: CardReadEvent = {
      ...this._base('card_read'),
      card_type,
      card_number: raceResult.cardNumber ?? card.cardNumber,
      start: toHalfDayClock(raceResult.startTime, raceResult.startCode, raceResult.startSubsec256),
      finish: toHalfDayClock(
        raceResult.finishTime,
        raceResult.finishCode,
        raceResult.finishSubsec256
      ),
      check: toHalfDayClock(raceResult.checkTime, raceResult.checkCode),
      clear: toHalfDayClock(raceResult.clearTime),
      punch_count: c.punchCount ?? punches.length,
      punches,
      card_holder:
        raceResult.cardHolder === undefined
          ? null
          : snakeCaseKeys(raceResult.cardHolder as Record<string, unknown>),
    };
    const startFirst = toHalfDayClock(
      raceResult.startFirstTime,
      raceResult.startFirstCode,
      raceResult.startFirstSubsec256
    );
    if (raceResult.startFirstTime !== undefined) event.start_first = startFirst;
    const finishFirst = toHalfDayClock(
      raceResult.finishFirstTime,
      raceResult.finishFirstCode,
      raceResult.finishFirstSubsec256
    );
    if (raceResult.finishFirstTime !== undefined) event.finish_first = finishFirst;
    if (card.cardSeriesByte !== undefined) {
      event.card_series_byte = card.cardSeriesByte;
    }
    if (c.uid !== undefined) {
      event.uid = c.uid;
    }
    if (raceResult.batteryMillivolts !== undefined) event.battery_mv = raceResult.batteryMillivolts;
    if (raceResult.hardwareVersion !== undefined)
      event.hardware_version = raceResult.hardwareVersion;
    if (raceResult.softwareVersion !== undefined)
      event.software_version = raceResult.softwareVersion;
    if (raceResult.batteryDate !== undefined) event.battery_date = raceResult.batteryDate;
    if (this.includeRawPages) {
      // Best-effort: ModernSiCard / SiCard5 own a SiStorage with internalData
      // accessible via storage.getInternalData() — but the storage type is
      // private. Wire this when `--include-raw-pages` lands. For
      // Phase 0 the flag is plumbed but the field is omitted to keep the
      // discriminated-union shape clean. Future plan can populate by
      // base64-encoding storage bytes.
      // event.raw_pages_b64 = ...
    }
    this._write(event);
  }

  card_removed(payload: { card_number: number }): void {
    const event: CardRemovedEvent = {
      ...this._base('card_removed'),
      card_number: payload.card_number,
    };
    this._write(event);
  }

  card_unsupported(payload: {
    card_number: number;
    detect_command: number;
    card_series_byte?: number;
  }): void {
    const event: CardUnsupportedEvent = {
      ...this._base('card_unsupported'),
      card_number: payload.card_number,
      detect_command: payload.detect_command,
    };
    if (payload.card_series_byte !== undefined) event.card_series_byte = payload.card_series_byte;
    this._write(event);
  }

  /**
   * Emit a frame_error event. Consumes the typed `FrameError` from siProtocol
   * directly — explicitly forbids parsing stdout warning
   * strings. The hex-encoded fields (`expected_crc_hex`, `actual_crc_hex`,
   * `raw_bytes_hex`) are produced here from the typed CRC tuples + byte array.
   */
  frame_error(err: FrameError): void {
    const event: FrameErrorEvent = {
      ...this._base('frame_error'),
      error_code: err.error_code,
      bytes_consumed: err.bytes_consumed,
      raw_bytes_hex: toHexBytes(err.raw_bytes),
    };
    const expected = toHexPair(err.expected_crc);
    if (expected !== undefined) event.expected_crc_hex = expected;
    const actual = toHexPair(err.actual_crc);
    if (actual !== undefined) event.actual_crc_hex = actual;
    this._write(event);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _base<T extends NdjsonEvent['event']>(event: T): NdjsonBase & { event: T } {
    const base: NdjsonBase & { event: T } = {
      schema_version: 1,
      event,
      ts_ms: Date.now(),
      device_path: this.device_path,
    };
    if (this.device_serial !== undefined) {
      base.device_serial = this.device_serial;
    }
    return base;
  }

  private _write(event: NdjsonEvent): void {
    this.out(JSON.stringify(event) + '\n');
  }
}
