// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/SiCard6.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Registers on its own SI6_DET-only registry (BaseSiCard.registerSi6Range),
//     like SiCard5/SI8 cards (no cross-capture).
//   - GET_SI6 response framing matches the hardware-verified GET_SI8 handling
//     in ModernSiCard: [cmd, len, addr_hi, addr_lo, block, ...128 data], so the
//     data starts at slice(5).
//   - Card holder page (block 1) is not read: upstream marks it untested on
//     real devices, and readout doesn't need it. One round trip fewer.
//   - Stripped lodash; no console warnings (decoders are pure).
//   - Test-only `_decodeFromStorage(bytes)` like the other card types.
//   - Punch control code via siPunchCode(): PTD bits 6-7 are code bits 8-9 (codes > 255).
//   - Start/finish/check station codes (CN plus PTD bit 6) read into startCode/finishCode/checkCode.
// See NOTICE.md for cumulative attribution.

import { proto } from '../../constants.ts';
import {
  SiTime,
  arr2cardNumber,
  siPunchCode,
  siSubsec256,
  siWeekdayRaw,
} from '../../siProtocol.ts';
import { type SiStorage, type SiStorageLocations, defineStorage } from '../../storage/SiStorage.ts';
import { SiArray } from '../../storage/SiArray.ts';
import { SiDataType } from '../../storage/SiDataType.ts';
import { SiDict } from '../../storage/SiDict.ts';
import { SiInt } from '../../storage/SiInt.ts';
import { SiModified } from '../../storage/SiModified.ts';
import { BaseSiCard } from '../BaseSiCard.ts';
import type { IBaseSiCardStorageFields } from '../ISiCard.ts';
import type { IPunch } from '../IRaceResultData.ts';

const punchesPerPage = 32;
const bytesPerPage = 128;
const MAX_NUM_PUNCHES = 64;

interface PotentialSiCard6Punch {
  code: number | undefined;
  time: number | null | undefined;
}

/** Punches live in blocks 6 and 7, 4 bytes each: [ptd, code, time_hi, time_lo]. */
export const getPunchOffset = (i: number): number => bytesPerPage * 6 + i * 4;

/** Punches up to the first empty slot (no code, or time 0xEEEE). A time out of
 * range (43200 and up) stays as `time: null`, so the punches after it are kept. */
export const cropPunches = (allPunches: (PotentialSiCard6Punch | undefined)[]): IPunch[] => {
  const end = allPunches.findIndex((p) => p?.code === undefined || p.time === null);
  // Keep every other field of the punch; only a missing time becomes null.
  return (end === -1 ? allPunches : allPunches.slice(0, end)).map((p) => ({
    ...p!,
    code: p!.code!,
    time: p!.time ?? null,
  }));
};

/** Station code of an SI6 start/finish record. With PTD bit 7 set CN holds the
 * subsecond instead of the code (SPORTident card data structure doc, provided
 * on request); the doc gives no other place for it on SI6, so: no code. */
const siCard6StartFinishCode = (
  recordOffset: number
): SiModified<{ ptd: number; code: number }, number> =>
  new SiModified(
    new SiDict<{ ptd: number; code: number }>({
      ptd: new SiInt([[recordOffset]]),
      code: siPunchCode(recordOffset),
    }) as unknown as SiDataType<{ ptd: number; code: number }>,
    ({ ptd, code }) => ((ptd & 0x80) !== 0 ? undefined : code)
  );

export type ISiCard6StorageFields = IBaseSiCardStorageFields;

export const siCard6StorageLocations: SiStorageLocations<ISiCard6StorageFields> = {
  cardNumber: new SiModified(
    new SiArray(3, (i) => new SiInt([[0x0b + (2 - i)]])),
    (extractedValue) => arr2cardNumber(extractedValue)
  ),
  startTime: new SiTime([[0x1b], [0x1a]], 0x18),
  finishTime: new SiTime([[0x17], [0x16]], 0x14),
  checkTime: new SiTime([[0x1f], [0x1e]], 0x1c),
  startCode: siCard6StartFinishCode(0x18),
  finishCode: siCard6StartFinishCode(0x14),
  checkCode: siPunchCode(0x1c),
  startWeekdayRaw: siWeekdayRaw(0x18),
  finishWeekdayRaw: siWeekdayRaw(0x14),
  checkWeekdayRaw: siWeekdayRaw(0x1c),
  clearWeekdayRaw: siWeekdayRaw(0x20),
  startSubsec256: siSubsec256(0x18),
  finishSubsec256: siSubsec256(0x14),
  clearTime: new SiTime([[0x23], [0x22]], 0x20),
  punchCount: new SiInt([[0x12]]),
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
    (allPunches) => cropPunches(allPunches as (PotentialSiCard6Punch | undefined)[])
  ),
  cardHolder: new SiDict({}),
};
export const siCard6StorageDefinition = defineStorage(0x400, siCard6StorageLocations);

export class SiCard6 extends BaseSiCard {
  static maxNumPunches = MAX_NUM_PUNCHES;

  readonly cardType = 'SI6' as const;
  public storage: SiStorage<ISiCard6StorageFields>;
  public punchCount?: number;

  constructor(cardNumber: number) {
    super(cardNumber);
    this.storage = siCard6StorageDefinition();
  }

  private getBlock(block: number): Promise<number[]> {
    if (!this.mainStation) return Promise.reject(new Error('No main station'));
    return this.mainStation
      .sendMessage({ command: proto.cmd.GET_SI6, parameters: [block] }, 1)
      .then((data: number[][]) => {
        const frame = data[0];
        if (frame === undefined) throw new Error(`No response for GET_SI6 block ${block}`);
        if (frame[4] !== block) {
          throw new Error(`GET_SI6 returned block ${frame[4]} (expected ${block})`);
        }
        return frame.slice(5);
      });
  }

  async typeSpecificRead(): Promise<void> {
    this.storage.splice(0, bytesPerPage, ...(await this.getBlock(0)));
    const punchCount = this.storage.get('punchCount')?.value ?? 0;
    if (punchCount > 0) {
      this.storage.splice(bytesPerPage * 6, bytesPerPage, ...(await this.getBlock(6)));
    }
    if (punchCount > punchesPerPage) {
      this.storage.splice(bytesPerPage * 7, bytesPerPage, ...(await this.getBlock(7)));
    }
    this.populateRaceResult();
  }

  /** Test-only: splice storage bytes and populate raceResult, no station. */
  _decodeFromStorage(storageBytes: (number | undefined)[]): void {
    const limit = Math.min(storageBytes.length, 0x400);
    for (let i = 0; i < limit; i++) {
      this.storage.splice(i, 1, storageBytes[i] as number);
    }
    this.populateRaceResult();
  }

  protected populateRaceResult(): void {
    const cn = this.storage.get('cardNumber')?.value;
    if (cn !== undefined) this.raceResult.cardNumber = cn;
    const startTime = this.storage.get('startTime')?.value;
    if (startTime !== undefined) this.raceResult.startTime = startTime;
    const startWeekday = this.storage.get('startWeekdayRaw')?.value;
    if (startTime != null && startWeekday !== undefined)
      this.raceResult.startWeekdayRaw = startWeekday;
    const startCode = this.storage.get('startCode')?.value;
    if (startTime != null && startCode !== undefined) this.raceResult.startCode = startCode;
    const startSubsec = this.storage.get('startSubsec256')?.value;
    if (startTime != null && startSubsec !== undefined)
      this.raceResult.startSubsec256 = startSubsec;
    const finishTime = this.storage.get('finishTime')?.value;
    if (finishTime !== undefined) this.raceResult.finishTime = finishTime;
    const finishWeekday = this.storage.get('finishWeekdayRaw')?.value;
    if (finishTime != null && finishWeekday !== undefined)
      this.raceResult.finishWeekdayRaw = finishWeekday;
    const finishCode = this.storage.get('finishCode')?.value;
    if (finishTime != null && finishCode !== undefined) this.raceResult.finishCode = finishCode;
    const finishSubsec = this.storage.get('finishSubsec256')?.value;
    if (finishTime != null && finishSubsec !== undefined)
      this.raceResult.finishSubsec256 = finishSubsec;
    const checkTime = this.storage.get('checkTime')?.value;
    if (checkTime !== undefined) this.raceResult.checkTime = checkTime;
    const checkWeekday = this.storage.get('checkWeekdayRaw')?.value;
    if (checkTime != null && checkWeekday !== undefined)
      this.raceResult.checkWeekdayRaw = checkWeekday;
    const checkCode = this.storage.get('checkCode')?.value;
    if (checkTime != null && checkCode !== undefined) this.raceResult.checkCode = checkCode;
    const clearTime = this.storage.get('clearTime')?.value;
    if (clearTime !== undefined) this.raceResult.clearTime = clearTime;
    const clearWeekday = this.storage.get('clearWeekdayRaw')?.value;
    if (clearTime != null && clearWeekday !== undefined)
      this.raceResult.clearWeekdayRaw = clearWeekday;
    const punches = this.storage.get('punches')?.value;
    // Slots past the punch count may still hold old punches.
    if (punches !== undefined)
      this.raceResult.punches = (punches as IPunch[]).slice(
        0,
        this.storage.get('punchCount')?.value
      );
    const punchCount = this.storage.get('punchCount')?.value;
    if (punchCount !== undefined) this.punchCount = punchCount;
  }
}

BaseSiCard.registerSi6Range(500_000, 1_000_000, SiCard6);
BaseSiCard.registerSi6Range(2_003_000, 2_004_000, SiCard6);
