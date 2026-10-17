// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/types/SiCard5.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - Storage backed by `(number|undefined)[]` (plain array), not Immutable.List.
//   - Registers on the SI5_DET-only registry via `BaseSiCard.registerSi5Range` —
//     enforces that SiCard5 NEVER captures SI8_DET messages even
//     if their cardNumber happens to fall in SI5's historical range.
//   - Stripped lodash; no enums.
//   - Upstream stdout-warning on storage mismatch removed (decoders are pure).
//   - Test-only `_decodeFromStorage(bytes)` helper that splices a single-page
//     storage blob and populates raceResult — fixture replay bypasses transport.
// See NOTICE.md for cumulative attribution.

import { proto } from '../../constants.ts';
import { type SiMessage, SiTime, arr2cardNumber } from '../../siProtocol.ts';
import { type SiStorage, type SiStorageLocations, defineStorage } from '../../storage/SiStorage.ts';
import { SiArray } from '../../storage/SiArray.ts';
import { SiDict } from '../../storage/SiDict.ts';
import { SiInt } from '../../storage/SiInt.ts';
import { SiModified } from '../../storage/SiModified.ts';
import { BaseSiCard } from '../BaseSiCard.ts';
import type { IBaseSiCardStorageFields } from '../ISiCard.ts';
import type { IPunch } from '../IRaceResultData.ts';

const bytesPerPage = 128;
const MAX_NUM_PUNCHES = 36;

interface PotentialSiCard5Punch {
  code: number | undefined;
  time: number | null | undefined;
}

// Slot layout layout:
//   - Slots 0-29 (30 with-time punches): 3 bytes each at 0x20 + floor(i/5) + 1 + i*3
//     (the +floor(i/5) skips the per-block separator byte; the +1 skips the first
//     separator after the header).
//   - Slots 30-35 (6 codes-only): 1 byte each at 0x20 + (i-30) * 16.
export const getPunchOffset = (i: number): number =>
  i >= 30 ? 0x20 + (i - 30) * 16 : 0x20 + Math.floor(i / 5) + 1 + i * 3;

export const cropPunches = (allPunches: (PotentialSiCard5Punch | undefined)[]): IPunch[] => {
  const isPunchEntryValid = (punch: PotentialSiCard5Punch | undefined): punch is IPunch =>
    punch !== undefined && punch.code !== undefined && punch.code !== 0x00;
  const firstInvalidIndex = allPunches.findIndex((punch) => !isPunchEntryValid(punch));
  const punchesUntilInvalid =
    firstInvalidIndex === -1 ? allPunches : allPunches.slice(0, firstInvalidIndex);
  return punchesUntilInvalid.filter(isPunchEntryValid);
};

export interface ISiCard5StorageFields extends IBaseSiCardStorageFields {
  softwareVersion: number;
  cardHolder: {
    countryCode: number | undefined;
    clubCode: number | undefined;
  };
}

export const siCard5StorageLocations: SiStorageLocations<ISiCard5StorageFields> = {
  cardNumber: new SiModified(
    new SiArray(3, (i) => new SiInt([[[0x05, 0x04, 0x06][i] as number]])),
    (extractedValue) => arr2cardNumber(extractedValue)
  ),
  startTime: new SiTime([[0x14], [0x13]]),
  finishTime: new SiTime([[0x16], [0x15]]),
  checkTime: new SiTime([[0x1a], [0x19]]),
  punchCount: new SiModified(new SiInt([[0x17]]), (extractedValue) => extractedValue - 1),
  punches: new SiModified(
    new SiArray(
      MAX_NUM_PUNCHES,
      (i) =>
        new SiDict({
          code: new SiInt([[getPunchOffset(i) + 0]]),
          time: new SiTime(
            i >= 30 ? undefined : [[getPunchOffset(i) + 2], [getPunchOffset(i) + 1]]
          ),
        })
    ),
    (allPunches) => cropPunches(allPunches as (PotentialSiCard5Punch | undefined)[])
  ),
  cardHolder: new SiDict({
    countryCode: new SiInt([[0x01]]),
    clubCode: new SiInt([[0x03], [0x02]]),
  }),
  softwareVersion: new SiInt([[0x1b]]),
};
export const siCard5StorageDefinition = defineStorage(0x80, siCard5StorageLocations);

export class SiCard5 extends BaseSiCard {
  static maxNumPunches = MAX_NUM_PUNCHES;

  public storage: SiStorage<ISiCard5StorageFields>;
  public punchCount?: number;
  public softwareVersion?: number;

  constructor(cardNumber: number) {
    super(cardNumber);
    this.storage = siCard5StorageDefinition();
  }

  typeSpecificRead(): Promise<void> {
    if (!this.mainStation) {
      return Promise.reject(new Error('No main station'));
    }
    return this.mainStation
      .sendMessage({ command: proto.cmd.GET_SI5, parameters: [] }, 1)
      .then((data: number[][]) => {
        const frame = data[0];
        if (frame === undefined) {
          throw new Error('No response for GET_SI5');
        }
        // Skip 4-byte response header: [cmd, len, addr_hi, addr_lo]. SI5 payload
        // is the remaining 128 bytes. (Real-wire bench transcript 2026-05-13:
        // station emits 2-byte address before the page data — `parse` exposes it
        // through `parameters`, the multiplexer prepends [cmd, len] = 4 bytes
        // total to skip. Previous slice(2) was correct only for synthetic
        // fixtures that omit addr bytes, and caused SiStorage.splice to receive
        // 130 instead of 128 bytes on real hardware.)
        this.storage.splice(bytesPerPage * 0, bytesPerPage, ...frame.slice(4));
        this.populateRaceResult();
      });
  }

  /** Test-only: splice a single 128-byte SI5 page into storage and populate
   * raceResult. Bypasses the mainStation. */
  _decodeFromStorage(storageBytes: (number | undefined)[]): void {
    const limit = Math.min(storageBytes.length, 0x80);
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
    const finishTime = this.storage.get('finishTime')?.value;
    if (finishTime !== undefined) this.raceResult.finishTime = finishTime;
    const checkTime = this.storage.get('checkTime')?.value;
    if (checkTime !== undefined) this.raceResult.checkTime = checkTime;
    const punches = this.storage.get('punches')?.value;
    if (punches !== undefined) this.raceResult.punches = punches as IPunch[];
    const cardHolder = this.storage.get('cardHolder')?.value;
    if (cardHolder !== undefined) {
      this.raceResult.cardHolder = cardHolder as { [k: string]: unknown };
    }
    const punchCount = this.storage.get('punchCount')?.value;
    if (punchCount !== undefined) this.punchCount = punchCount;
    const softwareVersion = this.storage.get('softwareVersion')?.value;
    if (softwareVersion !== undefined) this.softwareVersion = softwareVersion;
  }
}

// Upstream registers `registerNumberRange(1000, 500000, SiCard5)`. We use the
// SI5_DET-only registry per — even if an SI8_DET frame ever
// arrives with cardNumber in 1000..500000, it cannot route to SiCard5. The
// `_` discard prevents lint from flagging the unused expression.
BaseSiCard.registerSi5Range(1000, 500_000, SiCard5);

// Acknowledgement of upstream's SI5_DET parser — kept for parity. We retain
// the export so external callers can synthesize a detection message
// programmatically (mostly useful in tests).
export const isSi5DetectionMessage = (
  message: SiMessage
): message is { command: number; parameters: number[] } =>
  message.mode === undefined && message.command === proto.cmd.SI5_DET;
