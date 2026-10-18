// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/IRaceResultData.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications: import path `siProtocol` -> `siProtocol.ts` (Node 22 strip-types
// requires the suffix; root tsconfig has `allowImportingTsExtensions: true`).
//   - startCode/finishCode/checkCode: station codes of the start, finish and check units.
//   - batteryMillivolts/hardwareVersion/softwareVersion/batteryDate: SIAC block 3.
// See NOTICE.md for cumulative attribution.

import type { SiTimestamp } from '../siProtocol.ts';

export interface IRaceResultData {
  cardNumber?: number;
  cardHolder?: { [property: string]: unknown };
  clearTime?: SiTimestamp;
  checkTime?: SiTimestamp;
  startTime?: SiTimestamp;
  finishTime?: SiTimestamp;
  /** Station codes (CN) of the units that stamped start/finish/check. Absent on SI5. */
  startCode?: number;
  finishCode?: number;
  checkCode?: number;
  /** Subsecond of the start/finish time in 1/256 s (0-255): PTD bit 7 set, CN = TSS. Absent: no fraction. SI6 and newer. */
  startSubsec256?: number;
  finishSubsec256?: number;
  /** Raw day-of-week field (PTD bits 3-1, 0-7; see dayOfWeekFromRaw) of the record, SI6 and newer. Not a date. */
  startWeekdayRaw?: number;
  finishWeekdayRaw?: number;
  checkWeekdayRaw?: number;
  clearWeekdayRaw?: number;
  /** SIAC reserve records (block 3): the FIRST start/finish punch after a clear;
   * the main record is the last. Time absent: not read (block 3 not read, or a
   * card without reserve records); null: read and empty (erased, 0xEEEE). Code
   * absent when the reserve record has a subsecond (PTD bit 7: its code is unknown). */
  startFirstTime?: SiTimestamp;
  finishFirstTime?: SiTimestamp;
  startFirstCode?: number;
  finishFirstCode?: number;
  startFirstSubsec256?: number;
  finishFirstSubsec256?: number;
  /** SIAC block 3: battery voltage in mV, hardware and software version "major.minor". */
  batteryMillivolts?: number;
  hardwareVersion?: string;
  softwareVersion?: string;
  /** SIAC block 3: battery date "YYYY-MM-DD", no time zone; the recommended
   * battery change is three years later. Absent when unknown. */
  batteryDate?: string;
  punches?: IPunch[];
}

export interface IPunch {
  code: number;
  time: SiTimestamp;
  /** Raw day-of-week field (PTD bits 3-1, 0-7; see dayOfWeekFromRaw). Absent on SI5. Not a date. */
  weekdayRaw?: number;
}
