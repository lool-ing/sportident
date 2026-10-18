// Ported from allestuetsmerweh/sportident.js — packages/sportident/src/SiCard/BaseSiCard.ts
// Upstream: https://github.com/allestuetsmerweh/sportident.js (MIT License)
// Local modifications:
//   - **Two registries:** SI5_DET and SI8_DET cannot capture each
//     other's cards. Upstream uses a single command-agnostic NumberRangeRegistry which
//     means an SI8_DET frame with a card number that *happens* to fall in SI5's
//     historical range (e.g. 50 000) would route to SiCard5. We split the registry
//     by detection command so SiCard5 is only consulted on SI5_DET (0xE5) and
//     SI9/SI10/SIAC are only consulted on SI8_DET (0xE8). Phase 0 dispatch within
//     SI8_DET is by card-number range; the series byte at `params[2]` is recorded
//     on the instance for forensic NDJSON emission but does not drive routing.
//     TODO(phase-1): switch SI11 dispatch to the series byte #4.
//   - Stripped lodash; no enums.
//   - Removed `getNormalizedRaceResult`, `getMonotonizedRaceResult`, and the
//     `raceResultTools.ts` dependency — Phase 0 is a pure decoder; race-result
//     normalization is Phase 1's job.
//   - `confirm()` (ACK reply) removed; the readout-side transport handles this.
//   - Subclasses implement `decodeFromStorage(bytes)`, which bypasses the
//     mainStation so fixture replay and `decodeRawPages` need no mock station.
// See NOTICE.md for cumulative attribution.

import { proto } from '../constants.ts';
import { arr2cardNumber, type SiMessage } from '../siProtocol.ts';
import type { CardType } from '../output/ndjson.ts';
import type { IRaceResultData } from './IRaceResultData.ts';
import { RAW_LAYOUTS, snapshotBlocks, type RawPages } from './rawPages.ts';

export interface ISiMainStation {
  sendMessage: (
    message: SiMessage,
    numResponses?: number,
    timeoutInMiliseconds?: number
  ) => Promise<number[][]>;
}

export type SiCardType<T extends BaseSiCard> = new (cardNumber: number) => T;

interface RangeEntry {
  min: number;
  max: number;
  cardClass: SiCardType<BaseSiCard>;
}

export abstract class BaseSiCard {
  // Two non-overlapping registries dispatched by detection command:
  private static si5DetectionRegistry: RangeEntry[] = [];
  private static si8DetectionRegistry: RangeEntry[] = [];
  private static si6DetectionRegistry: RangeEntry[] = [];

  static resetRegistries(): void {
    BaseSiCard.si5DetectionRegistry = [];
    BaseSiCard.si8DetectionRegistry = [];
    BaseSiCard.si6DetectionRegistry = [];
  }

  /** Register a card class to be instantiated when an SI5_DET (0xE5) message
   * carries a cardNumber in `[min, max)`. SI8_DET messages never consult this
   * registry. */
  static registerSi5Range(min: number, max: number, cardClass: SiCardType<BaseSiCard>): void {
    BaseSiCard.si5DetectionRegistry.push({ min, max, cardClass });
  }

  /** Register a card class to be instantiated when an SI8_DET (0xE8) message
   * carries a cardNumber in `[min, max)`. SI5_DET messages never consult this
   * registry. */
  static registerSi8Range(min: number, max: number, cardClass: SiCardType<BaseSiCard>): void {
    BaseSiCard.si8DetectionRegistry.push({ min, max, cardClass });
  }

  /** Register a card class for SI6_DET (0xE6) messages with a cardNumber in
   * `[min, max)`. Only SI6_DET consults this registry. */
  static registerSi6Range(min: number, max: number, cardClass: SiCardType<BaseSiCard>): void {
    BaseSiCard.si6DetectionRegistry.push({ min, max, cardClass });
  }

  /** Inspect a card-insertion message and instantiate the appropriate card
   * subclass. Returns `undefined` when the message is not an SI5_DET/SI6_DET/SI8_DET
   * or its cardNumber falls outside every registered range. */
  static detectFromMessage(message: SiMessage): BaseSiCard | undefined {
    if (message.mode !== undefined) return undefined;
    if (message.parameters.length < 6) return undefined;
    const cardNumber = arr2cardNumber([
      message.parameters[5],
      message.parameters[4],
      message.parameters[3],
    ]);
    if (cardNumber === undefined) return undefined;

    if (message.command === proto.cmd.SI5_DET) {
      const entry = BaseSiCard.si5DetectionRegistry.find(
        (e) => cardNumber >= e.min && cardNumber < e.max
      );
      if (!entry) return undefined;
      // Single-arg constructor; subclasses extend BaseSiCard which takes cardNumber.
      return new entry.cardClass(cardNumber);
    }
    if (message.command === proto.cmd.SI6_DET) {
      const entry = BaseSiCard.si6DetectionRegistry.find(
        (e) => cardNumber >= e.min && cardNumber < e.max
      );
      return entry ? new entry.cardClass(cardNumber) : undefined;
    }
    if (message.command === proto.cmd.SI8_DET) {
      const seriesByte = message.parameters[2];
      const entry = BaseSiCard.si8DetectionRegistry.find(
        (e) => cardNumber >= e.min && cardNumber < e.max
      );
      if (!entry) return undefined;
      const card = new entry.cardClass(cardNumber);
      // Forensic: record the SI8_DET series byte (params[2]) for downstream logging.
      // Range still drives dispatch in Phase 0.
      if (seriesByte !== undefined) card.cardSeriesByte = seriesByte;
      return card;
    }
    return undefined;
  }

  public mainStation?: ISiMainStation;
  public raceResult: IRaceResultData & { cardNumber: number };
  /** Raw series byte from an SI8_DET frame's params[2]. `undefined` for SI5
   * cards (no series byte) and for cards instantiated directly via
   * `decodeFromStorage` in tests. */
  public cardSeriesByte?: number;
  /** Set by the class the detection command picked, not inferred from the number. */
  abstract readonly cardType: CardType;
  abstract readonly storage: { readonly data: ReadonlyArray<number | undefined> };

  /** Splice raw card bytes (address = index; `undefined` = never read) into
   * storage and decode them, without a station. Supported API: `decodeRawPages`
   * and consumers depend on it, so changing what it decodes needs a version bump. */
  abstract decodeFromStorage(storageBytes: (number | undefined)[]): void;

  constructor(cardNumber: number) {
    this.raceResult = { cardNumber };
  }

  get cardNumber(): number {
    return this.raceResult.cardNumber;
  }

  /** Talks to the (real or fake) main station to read the card off the wire,
   * then populates `this.raceResult`. Pure decoders that don't need transport
   * should use `decodeFromStorage(bytes)` instead. */
  read(): Promise<BaseSiCard> {
    return this.typeSpecificRead().then(() => this);
  }

  /** Copy of the blocks the reader fetched, as the station returned them.
   * Call after `read()`; later changes to the card do not affect it. */
  rawPages(): RawPages {
    const { layout } = RAW_LAYOUTS[this.cardType as keyof typeof RAW_LAYOUTS];
    return { cardType: this.cardType, layout, blocks: snapshotBlocks(this.storage.data) };
  }

  abstract typeSpecificRead(): Promise<void>;

  toDict(): IRaceResultData {
    return this.raceResult;
  }

  toString(): string {
    return `${this.constructor.name} #${this.cardNumber}`;
  }
}
