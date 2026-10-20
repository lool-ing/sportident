// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/ModernSiCard.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Storage backed by `(number|undefined)[]` (plain array), not Immutable.List.
//   - `ModernSiCardSeries` exported as a `const ... as const` literal (no enums per
//     erasableSyntaxOnly: Node 22 strip-types-native pipeline rejects runtime enums).
//   - Stripped lodash; `_.range` replaced by `Array.from({length: n}, (_, i) => i)`.
//   - Two-registry split: concrete subclasses
//     SiCard9/SiCard10/SIAC call `BaseSiCard.registerSi8Range` (not the legacy single
//     `registerNumberRange`), so SI5_DET messages can never instantiate a modern card.
//   - typeSpecificRead chain explicitly issues `GET_SI8` with `parameters: [0x04]` for
//     the first punch page when the card has any punches — enforces
//     that punches live on pages 4-7, not page 0.
//   - Added a `decodeFromStorage(bytes)` helper that splices a complete
//     storage buffer (page0..page7 concatenated, or partial) into the SiStorage and
//     resolves the raceResult; fixture replay tests use this instead of a mock
//     station.
//   - Removed upstream's stdout-warning on storage mismatch (no console writes
//     from decoders; mismatch detection moves to the multiplexer).
//   - Punch control code via siPunchCode(): PTD bit 6 is code bit 8 (codes 256-511).
//   - Start/finish/check station codes (CN plus PTD bit 6) read into startCode/finishCode/checkCode;
//     a start/finish record with PTD bit 7 has lost its code, except on SIAC
//     firmware 4.0+, which keeps it in block 1 (0xa5 / 0xa9).
//   - On SIAC firmware 4.0+ block 1 (page 1) is always fetched when there is a
//     start or finish record (if the card holder step did not read it), and the
//     start/finish code is taken from there, also without PTD bit 7 (SPORTident
//     (Thomas, 2026-10-09 and 2026-10-13)).
//   - SIAC reserve records start_r / finish_r (block 3): the first start/finish
//     punch after a clear; the main record holds the last (SPORTident (Thomas,
//     2026-10-13); SPORTident card data structure (provided on request)).
//   - Block 3 (page 3) is read on SIAC (static readsBlock3) for battery voltage and
//     hardware/software version.
//   - SIAC battery date from block 3 (page 0x6F, 0x1bc-0x1be), "YYYY-MM-DD" or unknown.
// See NOTICE.md for cumulative attribution.

import { proto } from '../../constants.ts';
import {
  SiTime,
  type SiTimestamp,
  arr2cardNumber,
  siPunchCode,
  siRecordCode,
  siSubsec256,
  siWeekdayRaw,
  siacBlock1Code,
} from '../../siProtocol.ts';
import { type SiStorage, type SiStorageLocations, defineStorage } from '../../storage/SiStorage.ts';
import { SiArray } from '../../storage/SiArray.ts';
import { SiDict } from '../../storage/SiDict.ts';
import { SiEnum } from '../../storage/SiEnum.ts';
import { SiInt } from '../../storage/SiInt.ts';
import { SiModified } from '../../storage/SiModified.ts';
import { BaseSiCard } from '../BaseSiCard.ts';
import type { IBaseSiCardStorageFields } from '../ISiCard.ts';
import type { IPunch } from '../IRaceResultData.ts';

class ReadFinishedException {}
const punchesPerPage = 32;
const bytesPerPage = 128;
const MAX_NUM_PUNCHES = 128;

// `as const` map (no `enum` — would fail erasableSyntaxOnly).
// Values cross-verified against upstream `ModernSiCard.ts`.
// SiCard10, SIAC, SiCard11 all share series 0x0F upstream — disambiguation is by
// number range, not by series byte. fCard upstream is still TODO.
export const ModernSiCardSeries = {
  SiCard9: 0x01,
  SiCard8: 0x02,
  pCard: 0x04,
  tCard: 0x06,
  fCard: 0x0e,
  SiCard10: 0x0f,
  SIAC: 0x0f,
} as const;
export type ModernSiCardSeriesKey = keyof typeof ModernSiCardSeries;

export interface PotentialModernSiCardPunch {
  code: number | undefined;
  time: number | null | undefined;
}

export const getPunchOffset = (i: number): number => bytesPerPage * 4 + i * 4;

/** Punches up to the first empty slot (no code, or time 0xEEEE). A time out of
 * range (43200 and up) stays as `time: null`, so the punches after it are kept. */
export const cropPunches = (allPunches: (PotentialModernSiCardPunch | undefined)[]): IPunch[] => {
  const end = allPunches.findIndex((p) => p?.code === undefined || p.time === null);
  // Keep every other field of the punch; only a missing time becomes null.
  return (end === -1 ? allPunches : allPunches.slice(0, end)).map((p) => ({
    ...p!,
    code: p!.code!,
    time: p!.time ?? null,
  }));
};

export const getCroppedString = (charCodes: (number | undefined)[]): string => {
  const isCharacterInvalid = (charCode: number | undefined): boolean =>
    charCode === undefined || charCode === 0xee;
  const firstInvalidIndex = charCodes.findIndex(isCharacterInvalid);
  const croppedCharCodes = (
    firstInvalidIndex === -1 ? charCodes : charCodes.slice(0, firstInvalidIndex)
  ) as number[];
  return croppedCharCodes.map((charCode) => String.fromCharCode(charCode)).join('');
};

export const parseCardHolderString = (
  semicolonSeparatedString: string
): { [property: string]: unknown } => {
  const c = semicolonSeparatedString.split(';');
  return {
    firstName: c.length > 1 ? c[0] : undefined,
    lastName: c.length > 2 ? c[1] : undefined,
    gender: c.length > 3 ? c[2] : undefined,
    birthday: c.length > 4 ? c[3] : undefined,
    club: c.length > 5 ? c[4] : undefined,
    email: c.length > 6 ? c[5] : undefined,
    phone: c.length > 7 ? c[6] : undefined,
    city: c.length > 8 ? c[7] : undefined,
    street: c.length > 9 ? c[8] : undefined,
    zip: c.length > 10 ? c[9] : undefined,
    country: c.length > 11 ? c[10] : undefined,
    isComplete: c.length > 11,
  };
};

export const parseCardHolder = (
  maybeCharCodes: (number | undefined)[]
): { [property: string]: unknown } => {
  const semicolonSeparatedString = getCroppedString(maybeCharCodes);
  return parseCardHolderString(semicolonSeparatedString || '');
};

export interface IModernSiCardStorageFields extends IBaseSiCardStorageFields {
  uid: number;
  cardSeries: ModernSiCardSeriesKey;
  batteryMillivolts?: number;
  hardwareVersion?: string;
  softwareVersion?: string;
  batteryDate?: string;
  startCodeBlock1?: number;
  finishCodeBlock1?: number;
  startFirstTime?: SiTimestamp;
  finishFirstTime?: SiTimestamp;
  startFirstCode?: number;
  finishFirstCode?: number;
  startFirstSubsec256?: number;
  finishFirstSubsec256?: number;
}

/** "major.minor" from two block-3 bytes; undefined while erased (0xEE). */
const siVersion = (offset: number): SiModified<number[], string> =>
  new SiModified(new SiArray(2, (i) => new SiInt([[offset + i]])), (bytes) =>
    bytes.some((b) => b === undefined || b === 0xee) ? undefined : `${bytes[0]}.${bytes[1]}`
  ) as unknown as SiModified<number[], string>;

/** SIAC battery date "YYYY-MM-DD" from block-3 bytes yy mm dd (binary, year
 * 2000 + yy); undefined while erased, missing, not a calendar date, or after
 * the current year: a battery date is never in the future, and no SIAC has a
 * 19yy date (SPORTident's library gave 19yy for yy 27 and up on 2026-10-14). */
const siBatteryDate = (offset: number): SiModified<number[], string> =>
  new SiModified(new SiArray(3, (i) => new SiInt([[offset + i]])), (bytes) => {
    const [yy, mm, dd] = bytes as (number | undefined)[];
    if (yy === undefined || mm === undefined || dd === undefined) return undefined;
    const year = 2000 + yy;
    const d = new Date(Date.UTC(year, mm - 1, dd));
    if (year > new Date().getFullYear() || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd)
      return undefined;
    return d.toISOString().slice(0, 10);
  }) as unknown as SiModified<number[], string>;

export const modernSiCardStorageLocations: SiStorageLocations<IModernSiCardStorageFields> = {
  uid: new SiInt([[0x03], [0x02], [0x01], [0x00]]),
  // Cast: SiEnum<T extends {[key: string]: number}> returns `keyof T | undefined`.
  // ModernSiCardSeries is narrower (keys ARE the series names), so cast the whole
  // SiEnum instance to the location's expected SiDataType<ModernSiCardSeriesKey>.
  cardSeries: new SiEnum(
    [[0x18]],
    ModernSiCardSeries as unknown as { [k: string]: number }
  ) as unknown as SiEnum<{ [k in ModernSiCardSeriesKey]: number }>,
  cardNumber: new SiModified(
    new SiArray(3, (i) => new SiInt([[0x19 + (2 - i)]])),
    (extractedValue) => arr2cardNumber(extractedValue)
  ),
  startTime: new SiTime([[0x0f], [0x0e]], 0x0c),
  finishTime: new SiTime([[0x13], [0x12]], 0x10),
  checkTime: new SiTime([[0x0b], [0x0a]], 0x08),
  // Station codes, see siRecordCode / siacBlock1Code. The check record's code
  // is always its own CN + PTD bit 6, bit 7 or not (SPORTident (Thomas,
  // 2026-10-09); SPORTident.Communication 2.59.0 on card images, 2026-10-08).
  startCode: siRecordCode(0x0c),
  finishCode: siRecordCode(0x10),
  checkCode: siPunchCode(0x08),
  startCodeBlock1: siacBlock1Code(0xa5),
  finishCodeBlock1: siacBlock1Code(0xa9),
  startWeekdayRaw: siWeekdayRaw(0x0c),
  finishWeekdayRaw: siWeekdayRaw(0x10),
  checkWeekdayRaw: siWeekdayRaw(0x08),
  startSubsec256: siSubsec256(0x0c),
  finishSubsec256: siSubsec256(0x10),
  punchCount: new SiInt([[0x16]]),
  punches: new SiModified(
    new SiArray(
      MAX_NUM_PUNCHES,
      (i) =>
        new SiDict({
          code: siPunchCode(getPunchOffset(i)),
          time: new SiTime([[getPunchOffset(i) + 3], [getPunchOffset(i) + 2]], getPunchOffset(i)),
          weekdayRaw: siWeekdayRaw(getPunchOffset(i)),
        })
    ),
    (allPunches) => cropPunches(allPunches as (PotentialModernSiCardPunch | undefined)[])
  ),
  cardHolder: new SiModified(new SiArray(0x80, (i) => new SiInt([[0x20 + i]])), (charCodes) =>
    parseCardHolder(charCodes)
  ),
  // Reserve records (block 3, SIAC only): start_r at page 0x76 = byte 0x1d8,
  // finish_r at page 0x77 = byte 0x1dc; same 4-byte layout as the main
  // start/finish records (SPORTident card data structure, provided on
  // request). Written by the first punch after a clear. A reserve record with
  // PTD bit 7 has a subsecond in CN and its code is unknown: block 1 holds the
  // code of the MAIN record only (open question to SPORTident, 2026-10-13).
  startFirstTime: new SiTime([[0x1d8 + 3], [0x1d8 + 2]], 0x1d8),
  finishFirstTime: new SiTime([[0x1dc + 3], [0x1dc + 2]], 0x1dc),
  startFirstCode: siRecordCode(0x1d8),
  finishFirstCode: siRecordCode(0x1dc),
  startFirstSubsec256: siSubsec256(0x1d8),
  finishFirstSubsec256: siSubsec256(0x1dc),
  // Block 3 (SIAC only, see readsBlock3). Battery: 1.9 V + n × 0.09 V, over
  // 5 V means no valid value (MeOS SportIdent.cpp:1490-1497; same byte and
  // formula in SPORTident.Communication 2.59.0, black-box byte sweep of siac-bench-001, 2026-10-08).
  batteryMillivolts: new SiModified(new SiInt([[0x1c7]]), (n) => {
    const mv = 1900 + 90 * n;
    return mv > 5000 ? undefined : mv;
  }),
  // Hardware and software version, major.minor (SPORTident.Communication 2.59.0, black-box byte sweep of siac-bench-001, 2026-10-08).
  hardwareVersion: siVersion(0x1c0),
  softwareVersion: siVersion(0x1c2),
  // Battery date, page 0x6F: yy mm dd and a character-set byte (SPORTident card
  // data structure, provided on request). Binary, 2000 + yy: SPORTident.Communication
  // 2.59.0 on synthetic SIAC images, 2026-10-14.
  batteryDate: siBatteryDate(0x1bc),
};
export const modernSiCardStorageDefinition = defineStorage(0x400, modernSiCardStorageLocations);

const BATTERY_MEASURE_TIMEOUT_MS = 1_000;
const BATTERY_MEASURE_PAUSE_MS = 100;

export abstract class ModernSiCard extends BaseSiCard {
  static maxNumPunches = MAX_NUM_PUNCHES;
  /** Read block 3 (battery, versions); SPORTident's library reads it on
   * SIAC (SPORTident.Communication 2.59.0, black-box byte sweep of siac-bench-001, 2026-10-08). */
  static readsBlock3 = false;

  public storage: SiStorage<IModernSiCardStorageFields>;
  public cardSeries?: ModernSiCardSeriesKey;
  public uid?: number;
  protected block1Read = false;
  /** Measure the battery before block 3 is read (SiMainStation's
   * measureSiacBattery). Only cards that read block 3 (SIAC) measure. */
  measureBattery = false;

  constructor(cardNumber: number) {
    super(cardNumber);
    this.storage = modernSiCardStorageDefinition();
  }

  // Modern card pages / Modern card layout.
  // Page 0 = header/metadata. Page 1 = cardholder. Pages 4-7 = punches
  // (32 punches/page). punches start at page 4, NOT page 0.
  // Sequence is strictly forward; SiSendTask serializes the GET_SI8
  // calls.
  typeSpecificGetPage(pageNumber: number): Promise<number[]> {
    if (!this.mainStation) {
      return Promise.reject(new Error('No main station'));
    }
    return this.mainStation
      .sendMessage({ command: proto.cmd.GET_SI8, parameters: [pageNumber] }, 1)
      .then((data: number[][]) => {
        const frame = data[0];
        if (frame === undefined) {
          throw new Error(`No response for GET_SI8 page ${pageNumber}`);
        }
        if (frame[4] !== pageNumber) {
          throw new Error(`GET_SI8 returned page ${frame[4]} (expected ${pageNumber})`);
        }
        // Skip 5-byte response header: [cmd, len, addr_hi, addr_lo, page_no].
        // Page payload is 128 bytes. (Real-wire bench transcript 2026-05-13:
        // GET_SI8 response carries [addr_hi, addr_lo, page_no, ...128 data] in
        // `parameters`; the multiplexer prepends [cmd, len] = 5 header bytes
        // total. Previous slice(3) was correct only for synthetic fixtures
        // that omit the 2-byte station address.)
        return frame.slice(5);
      });
  }

  typeSpecificRead(): Promise<void> {
    return this.typeSpecificReadBasic()
      .then(() => this.typeSpecificReadBlock3())
      .then(() => this.typeSpecificReadCardHolder())
      .then(() => this.typeSpecificReadCodeBlock())
      .then(() => this.typeSpecificReadPunches())
      .then(() => this.populateRaceResult());
  }

  typeSpecificReadBasic(): Promise<void> {
    return this.typeSpecificGetPage(0).then((page0) => {
      this.storage.splice(bytesPerPage * 0, bytesPerPage, ...page0);
    });
  }

  typeSpecificReadBlock3(): Promise<void> {
    if (!(this.constructor as typeof ModernSiCard).readsBlock3) return Promise.resolve();
    return this.measureBatteryFirst()
      .then(() => this.typeSpecificGetPage(3))
      .then((page3) => {
        this.storage.splice(bytesPerPage * 3, bytesPerPage, ...page3);
      });
  }

  /** The battery voltage in block 3 is only current after a measurement: write
   * 05 05 05 05 to page 0x7E, then wait 100 ms before reading block 3 (SPORTident
   * Config+ changelog 0.8.14; the same command in MeOS SportIdent.cpp:1430-1443).
   * Reply timeout 1000 ms (Config+ 0.9.0). A NAK or no reply keeps the stored
   * value and the read goes on: a weak battery may not answer (Config+ CONFIG-404). */
  private measureBatteryFirst(): Promise<void> {
    if (!this.measureBattery || !this.mainStation) return Promise.resolve();
    return this.mainStation
      .sendMessage(
        { command: proto.cmd.SET_SI8, parameters: [0x7e, 0x05, 0x05, 0x05, 0x05] },
        1,
        BATTERY_MEASURE_TIMEOUT_MS
      )
      .then(
        () => new Promise<void>((resolve) => setTimeout(resolve, BATTERY_MEASURE_PAUSE_MS)),
        () => undefined
      );
  }

  typeSpecificReadCardHolder(): Promise<void> {
    const cardHolderSoFar = this.storage.get('cardHolder');
    if (cardHolderSoFar && (cardHolderSoFar.value as { isComplete?: boolean }).isComplete) {
      return Promise.resolve();
    }
    return this.readBlock1();
  }

  protected readBlock1(): Promise<void> {
    return this.typeSpecificGetPage(1).then((page1) => {
      this.storage.splice(bytesPerPage * 1, bytesPerPage, ...page1);
      this.block1Read = true;
    });
  }

  /** SIAC with firmware 4.0 or later keeps start/finish codes in block 1
   * (0xa5 / 0xa9); other cards and older firmware never do (SPORTident
   * (Thomas, 2026-10-09)). Needs block 3 (software version) read first. */
  protected keepsBlock1Codes(): boolean {
    if (!(this.constructor as typeof ModernSiCard).readsBlock3) return false;
    const major = Number(this.storage.get('softwareVersion')?.value?.split('.')[0]);
    return Number.isInteger(major) && major >= 4;
  }

  /** True when there is a start or finish record in page 0, the card keeps
   * their codes in block 1, and block 1 has not been read. */
  protected needsBlock1(): boolean {
    if (this.block1Read || !this.keepsBlock1Codes()) return false;
    return (['start', 'finish'] as const).some(
      (name) => this.storage.get(`${name}Time`)?.value != null
    );
  }

  typeSpecificReadCodeBlock(): Promise<void> {
    if (!this.needsBlock1()) return Promise.resolve();
    return this.readBlock1();
  }

  typeSpecificReadPunches(): Promise<void> {
    const punchCount = this.storage.get('punchCount')?.value ?? 0;
    if (punchCount <= punchesPerPage * 0) {
      return Promise.resolve();
    }
    return this.typeSpecificGetPage(0x04)
      .then((page4) => {
        this.storage.splice(bytesPerPage * 4, bytesPerPage, ...page4);
        if ((this.storage.get('punchCount')?.value ?? 0) <= punchesPerPage * 1) {
          throw new ReadFinishedException();
        }
        return this.typeSpecificGetPage(0x05);
      })
      .then((page5) => {
        this.storage.splice(bytesPerPage * 5, bytesPerPage, ...page5);
        if ((this.storage.get('punchCount')?.value ?? 0) <= punchesPerPage * 2) {
          throw new ReadFinishedException();
        }
        return this.typeSpecificGetPage(0x06);
      })
      .then((page6) => {
        this.storage.splice(bytesPerPage * 6, bytesPerPage, ...page6);
        if ((this.storage.get('punchCount')?.value ?? 0) <= punchesPerPage * 3) {
          throw new ReadFinishedException();
        }
        return this.typeSpecificGetPage(0x07);
      })
      .then((page7) => {
        this.storage.splice(bytesPerPage * 7, bytesPerPage, ...page7);
        throw new ReadFinishedException();
      })
      .catch((exc: unknown) => {
        if (exc instanceof ReadFinishedException) return;
        throw exc;
      });
  }

  /** Splice raw storage bytes (page 0..page 7 concatenated, or any
   * prefix) into the SiStorage buffer and populate the raceResult. Bypasses
   * the mainStation so fixture replay doesn't need a mock transport. */
  decodeFromStorage(storageBytes: (number | undefined)[]): void {
    // Splice in chunks so an undefined-tail (e.g. tests that only ship page 0)
    // doesn't blow size limits.
    const limit = Math.min(storageBytes.length, 0x400);
    for (let i = 0; i < limit; i++) {
      // Use a 1-element splice (replaces one byte in-place); preserves length.
      this.storage.splice(i, 1, storageBytes[i] as number);
    }
    this.populateRaceResult();
  }

  /** Start/finish code: block 1 (0xa5 / 0xa9) on SIAC firmware 4.0+, bit 7 or
   * not; 0x00 there means not available. Otherwise the record's own (CN +
   * bit 6), lost when PTD bit 7 is set. (The 0xEE case is an open question
   * to SPORTident, 2026-10-13.) */
  private recordCode(name: 'start' | 'finish'): number | undefined {
    const own = this.storage.get(`${name}Code`)?.value;
    if (!this.keepsBlock1Codes()) return own;
    const b1 = this.storage.get(`${name}CodeBlock1`)?.value;
    // shortcut: 0xEE is unwritten or code 238 (open question to SPORTident);
    // without bit 7 CN still holds the code, with bit 7 the code is lost even
    // if it was 238. Settle once SPORTident answers.
    return b1 === 0xee ? own : b1;
  }

  protected populateRaceResult(): void {
    const cn = this.storage.get('cardNumber')?.value;
    if (cn !== undefined) {
      this.raceResult.cardNumber = cn;
    }
    const startTime = this.storage.get('startTime')?.value;
    if (startTime !== undefined) this.raceResult.startTime = startTime;
    const startWeekday = this.storage.get('startWeekdayRaw')?.value;
    if (startTime != null && startWeekday !== undefined)
      this.raceResult.startWeekdayRaw = startWeekday;
    const startCode = this.recordCode('start');
    if (startTime != null && startCode !== undefined) this.raceResult.startCode = startCode;
    const startSubsec = this.storage.get('startSubsec256')?.value;
    if (startTime != null && startSubsec !== undefined)
      this.raceResult.startSubsec256 = startSubsec;
    const finishTime = this.storage.get('finishTime')?.value;
    if (finishTime !== undefined) this.raceResult.finishTime = finishTime;
    const finishWeekday = this.storage.get('finishWeekdayRaw')?.value;
    if (finishTime != null && finishWeekday !== undefined)
      this.raceResult.finishWeekdayRaw = finishWeekday;
    const finishCode = this.recordCode('finish');
    if (finishTime != null && finishCode !== undefined) this.raceResult.finishCode = finishCode;
    const finishSubsec = this.storage.get('finishSubsec256')?.value;
    if (finishTime != null && finishSubsec !== undefined)
      this.raceResult.finishSubsec256 = finishSubsec;
    if ((this.constructor as typeof ModernSiCard).readsBlock3) {
      for (const name of ['start', 'finish'] as const) {
        const time = this.storage.get(`${name}FirstTime`)?.value;
        // Not read (undefined): absent. Erased (0xEEEE, null): empty, kept as null.
        // Neither is ever "same as main".
        if (time === undefined) continue;
        this.raceResult[`${name}FirstTime`] = time;
        if (time === null) continue; // an erased record's PTD/CN are no code or fraction
        const code = this.storage.get(`${name}FirstCode`)?.value;
        if (code !== undefined) this.raceResult[`${name}FirstCode`] = code;
        const subsec = this.storage.get(`${name}FirstSubsec256`)?.value;
        if (subsec !== undefined) this.raceResult[`${name}FirstSubsec256`] = subsec;
      }
    }
    const checkTime = this.storage.get('checkTime')?.value;
    if (checkTime !== undefined) this.raceResult.checkTime = checkTime;
    const checkWeekday = this.storage.get('checkWeekdayRaw')?.value;
    if (checkTime != null && checkWeekday !== undefined)
      this.raceResult.checkWeekdayRaw = checkWeekday;
    const checkCode = this.storage.get('checkCode')?.value;
    if (checkTime != null && checkCode !== undefined) this.raceResult.checkCode = checkCode;
    const punches = this.storage.get('punches')?.value;
    // Slots past the punch count may still hold old punches.
    if (punches !== undefined)
      this.raceResult.punches = (punches as IPunch[]).slice(
        0,
        this.storage.get('punchCount')?.value
      );
    const cardHolder = this.storage.get('cardHolder')?.value;
    if (cardHolder !== undefined) {
      this.raceResult.cardHolder = cardHolder as { [k: string]: unknown };
    }
    const punchCount = this.storage.get('punchCount')?.value;
    if (punchCount !== undefined) this.punchCount = punchCount;
    const cardSeries = this.storage.get('cardSeries')?.value;
    if (cardSeries !== undefined) this.cardSeries = cardSeries;
    const uid = this.storage.get('uid')?.value;
    if (uid !== undefined) this.uid = uid;
    if ((this.constructor as typeof ModernSiCard).readsBlock3) {
      const battery = this.storage.get('batteryMillivolts')?.value;
      if (battery !== undefined) this.raceResult.batteryMillivolts = battery;
      const hardware = this.storage.get('hardwareVersion')?.value;
      if (hardware !== undefined) this.raceResult.hardwareVersion = hardware;
      const software = this.storage.get('softwareVersion')?.value;
      if (software !== undefined) this.raceResult.softwareVersion = software;
      const batteryDate = this.storage.get('batteryDate')?.value;
      if (batteryDate !== undefined) this.raceResult.batteryDate = batteryDate;
    }
  }
}
