// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/SiCard9.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Storage backed by `(number|undefined)[]` (plain array), not Immutable.List.
//   - Registers on the SI8_DET-only registry via `BaseSiCard.registerSi8Range` —
//     enforces that SiCard9 NEVER captures SI5_DET messages.
//   - Stripped lodash; no enums.
//   - Upstream stdout-warning on storage mismatch removed (decoders are pure).
//   - Test-only `_decodeFromStorage(bytes)` helper that splices a multi-page
//     storage blob (pages 0+1 expected for SI9 since max 50 punches in 2 pages).
//   - Punch control code via siPunchCode(): PTD bits 6-7 are code bits 8-9 (codes > 255).
//   - Start/finish/check station codes (CN plus PTD bit 6; lost on a start/finish record with PTD bit 7) read into startCode/finishCode/checkCode.
// See NOTICE.md for cumulative attribution.

import {
  SiTime,
  arr2cardNumber,
  siPunchCode,
  siRecordCode,
  siSubsec256,
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
import {
  ModernSiCard,
  ModernSiCardSeries,
  type ModernSiCardSeriesKey,
  cropPunches,
  getCroppedString,
  type PotentialModernSiCardPunch,
} from './ModernSiCard.ts';

class ReadFinishedException {}
const punchesPerPage = 32;
const bytesPerPage = 128;
const MAX_NUM_PUNCHES = 50;

export const getPunchOffset = (i: number): number => 0x38 + i * 4;

const parseSiCard9CardHolderString = (
  semicolonSeparatedString: string
): { [property: string]: unknown } => {
  const informationComponents = semicolonSeparatedString.split(';');
  return {
    firstName: informationComponents.length > 1 ? informationComponents[0] : undefined,
    lastName: informationComponents.length > 2 ? informationComponents[1] : undefined,
    isComplete: informationComponents.length > 2,
  };
};

const parseSiCard9CardHolder = (
  maybeCharCodes: (number | undefined)[]
): { [property: string]: unknown } => {
  const semicolonSeparatedString = getCroppedString(maybeCharCodes);
  return parseSiCard9CardHolderString(semicolonSeparatedString || '');
};

export interface ISiCard9StorageFields extends IBaseSiCardStorageFields {
  uid: number;
  cardSeries: ModernSiCardSeriesKey;
}

export const siCard9StorageLocations: SiStorageLocations<ISiCard9StorageFields> = {
  uid: new SiInt([[0x03], [0x02], [0x01], [0x00]]),
  // Same cast pattern as ModernSiCard: widened SiEnum -> narrower keyof-typed location.
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
  // Station codes, see siRecordCode. Block 1 holds punches on SI8/SI9, so a
  // start/finish code lost to PTD bit 7 is not kept anywhere. The check
  // record's code is its own CN + PTD bit 6.
  startCode: siRecordCode(0x0c),
  finishCode: siRecordCode(0x10),
  checkCode: siPunchCode(0x08),
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
        })
    ),
    (allPunches) => cropPunches(allPunches as (PotentialModernSiCardPunch | undefined)[])
  ),
  // SI9 cardholder is shorter (24 bytes) and uses only firstName;lastName.
  cardHolder: new SiModified(new SiArray(0x18, (i) => new SiInt([[0x20 + i]])), (charCodes) =>
    parseSiCard9CardHolder(charCodes)
  ),
};
export const siCard9StorageDefinition = defineStorage(0x100, siCard9StorageLocations);

export class SiCard9 extends ModernSiCard {
  static maxNumPunches = MAX_NUM_PUNCHES;
  public storage: SiStorage<ISiCard9StorageFields>;

  constructor(cardNumber: number) {
    super(cardNumber);
    this.storage = siCard9StorageDefinition();
  }

  typeSpecificRead(): Promise<void> {
    return this.typeSpecificGetPage(0)
      .then((page0) => {
        this.storage.splice(bytesPerPage * 0, bytesPerPage, ...page0);
        if (
          (this.storage.get('punchCount')?.value ?? 0) <= punchesPerPage * 0 &&
          !this.needsBlock1()
        ) {
          throw new ReadFinishedException();
        }
        return this.typeSpecificGetPage(1);
      })
      .then((page1) => {
        this.storage.splice(bytesPerPage * 1, bytesPerPage, ...page1);
        throw new ReadFinishedException();
      })
      .catch((exc: unknown) => {
        if (exc instanceof ReadFinishedException) {
          this.populateSi9RaceResult();
          return;
        }
        throw exc;
      });
  }

  override _decodeFromStorage(storageBytes: (number | undefined)[]): void {
    const limit = Math.min(storageBytes.length, 0x100);
    for (let i = 0; i < limit; i++) {
      this.storage.splice(i, 1, storageBytes[i] as number);
    }
    this.populateSi9RaceResult();
  }

  // SI9 cardholder shape diverges from ModernSiCard's; populate the SI9-specific
  // result here. punchCount / cardSeries / uid still come from the inherited
  // shape (same byte offsets).
  protected populateSi9RaceResult(): void {
    const cn = this.storage.get('cardNumber')?.value;
    if (cn !== undefined) this.raceResult.cardNumber = cn;
    const startTime = this.storage.get('startTime')?.value;
    if (startTime !== undefined) this.raceResult.startTime = startTime;
    const startCode = this.storage.get('startCode')?.value;
    if (startTime != null && startCode !== undefined) this.raceResult.startCode = startCode;
    const startSubsec = this.storage.get('startSubsec256')?.value;
    if (startTime != null && startSubsec !== undefined)
      this.raceResult.startSubsec256 = startSubsec;
    const finishTime = this.storage.get('finishTime')?.value;
    if (finishTime !== undefined) this.raceResult.finishTime = finishTime;
    const finishCode = this.storage.get('finishCode')?.value;
    if (finishTime != null && finishCode !== undefined) this.raceResult.finishCode = finishCode;
    const finishSubsec = this.storage.get('finishSubsec256')?.value;
    if (finishTime != null && finishSubsec !== undefined)
      this.raceResult.finishSubsec256 = finishSubsec;
    const checkTime = this.storage.get('checkTime')?.value;
    if (checkTime !== undefined) this.raceResult.checkTime = checkTime;
    const checkCode = this.storage.get('checkCode')?.value;
    if (checkTime != null && checkCode !== undefined) this.raceResult.checkCode = checkCode;
    const punches = this.storage.get('punches')?.value;
    if (punches !== undefined) this.raceResult.punches = punches as IPunch[];
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
  }
}

BaseSiCard.registerSi8Range(1_000_000, 2_000_000, SiCard9);
