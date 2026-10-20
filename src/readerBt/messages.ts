// Authored for lool. Not ported from upstream.
//
// SPORTident Reader BT messages over Bluetooth Low Energy: framing, reassembly
// of segmented notifications and the minimal card readout. Facts from
// docs.sportident.com/developers/reader-bt (see docs/reader-bt.md). No Node
// APIs, so it also runs in a browser.

import type { IRaceResultData, IPunch } from '../SiCard/IRaceResultData.ts';

const uuid = (xx: string): string => `bd5100${xx}-6aec-4628-a146-f3e95bc49e62`;

export const READER_BT_UUID = {
  /** Advertised; scan for this one. */
  settingsService: uuid('01'),
  cardReadoutService: uuid('11'),
  cardState: uuid('12'),
  cardData: uuid('13'),
} as const;

export const READER_BT_MSG = {
  cardStateChange: 0x1101,
  cardReadoutMinimal: 0x1102,
  feedback: 0x1110,
  segment: 0xa101,
} as const;

export const FEEDBACK = { ok: 1, error: 2 } as const;

/** Punch types of a readout record. */
export const PUNCH_TYPE = {
  undefined: 0,
  clear: 1,
  check: 2,
  start: 3,
  startReserve: 4,
  finish: 5,
  finishReserve: 6,
  control: 7,
} as const;

const DAY_MS = 86_400_000;
const HEADER = 4;
const PUNCH_SIZE = 8;

export class ReaderBtDecodeError extends Error {
  override name = 'ReaderBtDecodeError';
}

export const encodeMessage = (id: number, payload: ArrayLike<number> = []): Uint8Array => {
  const bytes = new Uint8Array(HEADER + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, id, true);
  view.setUint16(2, payload.length, true);
  bytes.set(payload, HEADER);
  return bytes;
};

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** One message: its id and payload, after checking the header's length. */
export const splitMessage = (bytes: Uint8Array): { id: number; payload: Uint8Array } => {
  if (bytes.length < HEADER) throw new ReaderBtDecodeError(`message of ${bytes.length} bytes`);
  const v = view(bytes);
  const length = v.getUint16(2, true);
  if (bytes.length !== HEADER + length) {
    throw new ReaderBtDecodeError(`payload_length ${length} but ${bytes.length - HEADER} bytes`);
  }
  return { id: v.getUint16(0, true), payload: bytes.subarray(HEADER) };
};

export type ReassemblyResult = { message: Uint8Array } | { error: string } | null;

/**
 * Turns notifications into whole messages. A segment message (0xA101) carries
 * a flag byte: 1 first (then the total length as uint32), 0 continuation,
 * 2 last. Returns null while a segmented message is still incomplete.
 */
export class Reassembler {
  private parts: Uint8Array[] | undefined;
  private total = 0;
  private received = 0;

  push(notification: Uint8Array): ReassemblyResult {
    let id: number;
    let payload: Uint8Array;
    try {
      ({ id, payload } = splitMessage(notification));
    } catch (err) {
      this.reset();
      return { error: (err as Error).message };
    }
    if (id !== READER_BT_MSG.segment) {
      // A whole message in the middle of a segmented one is kept; the
      // half-built one is lost.
      this.reset();
      return { message: notification };
    }
    const flag = payload[0];
    if (flag === 1) {
      const lost = this.parts !== undefined;
      if (payload.length < 5) {
        this.reset();
        return { error: 'first segment without total length' };
      }
      this.parts = [];
      this.total = view(payload).getUint32(1, true);
      this.received = 0;
      this.append(payload.subarray(5));
      if (lost) return { error: 'segmented message restarted' };
      return null;
    }
    if (this.parts === undefined) return { error: `segment flag ${flag} without a first segment` };
    if (flag === 0) {
      this.append(payload.subarray(1));
      if (this.received > this.total) {
        this.reset();
        return { error: 'segments longer than the total length' };
      }
      return null;
    }
    if (flag === 2) {
      this.append(payload.subarray(1));
      const { parts, received, total } = this;
      this.reset();
      if (received !== total) return { error: 'segments do not add up to the total length' };
      const message = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        message.set(p, at);
        at += p.length;
      }
      return { message };
    }
    this.reset();
    return { error: `unknown segment flag ${flag}` };
  }

  reset(): void {
    this.parts = undefined;
    this.total = 0;
    this.received = 0;
  }

  private append(segment: Uint8Array): void {
    this.parts!.push(segment.slice());
    this.received += segment.length;
  }
}

export interface CardStateChange {
  cardNumber: number;
  inserted: boolean;
  /** The reader's own control code. */
  stationCode: number;
}

export const decodeCardState = (payload: Uint8Array): CardStateChange => {
  if (payload.length < 7) throw new ReaderBtDecodeError(`card state of ${payload.length} bytes`);
  const v = view(payload);
  return {
    cardNumber: v.getUint32(0, true),
    inserted: v.getUint8(4) === 1,
    stationCode: v.getUint16(5, true),
  };
};

export interface ReaderBtPunch {
  /** See PUNCH_TYPE. */
  type: number;
  code: number;
  /** Milliseconds since Sunday 00:00:00. */
  timeMs: number;
  /** SIAC beacon and radio mode bits; 0 on other cards. */
  controlInfo: number;
}

export interface ReaderBtReadout {
  cardNumber: number;
  /** 1 SI-Card 9, 2 SI-Card 8, 4 SI-pCard, 15 SIAC; other values are kept as sent. */
  cardFamily: number;
  punches: ReaderBtPunch[];
  /** The whole message: store it as the evidence of the read and decode it
   * again with decodeReadout (a Reader BT read has no raw card pages). */
  bytes: Uint8Array;
}

/** Decodes a whole minimal readout message (0x1102), header included. */
export const decodeReadout = (bytes: Uint8Array): ReaderBtReadout => {
  const { id, payload } = splitMessage(bytes);
  if (id !== READER_BT_MSG.cardReadoutMinimal) {
    throw new ReaderBtDecodeError(`message 0x${id.toString(16)} is not a minimal readout`);
  }
  if (payload.length < 7) throw new ReaderBtDecodeError(`readout of ${payload.length} bytes`);
  const v = view(payload);
  const count = v.getUint16(5, true);
  if (payload.length !== 7 + count * PUNCH_SIZE) {
    throw new ReaderBtDecodeError(`${count} punches do not fit ${payload.length} bytes`);
  }
  const punches: ReaderBtPunch[] = [];
  for (let at = 7; at < payload.length; at += PUNCH_SIZE) {
    punches.push({
      controlInfo: v.getUint8(at),
      type: v.getUint8(at + 1),
      code: v.getUint16(at + 2, true),
      timeMs: v.getUint32(at + 4, true),
    });
  }
  return {
    cardNumber: v.getUint32(0, true),
    cardFamily: v.getUint8(4),
    punches,
    bytes: bytes.slice(),
  };
};

/** Seconds since midnight and day of week (0 Sunday), the form the serial
 * decoders give (`SiTimestamp`, `weekdayRaw`). */
const clock = (timeMs: number) => ({
  time: Math.floor((timeMs % DAY_MS) / 1000),
  // 7 = not a valid day, as dayOfWeekFromRaw reads it.
  weekdayRaw: Math.min(Math.floor(timeMs / DAY_MS), 7),
  // shortcut: assumes the reader's ms come from the card's 1/256 s; the nearest 1/256 s otherwise.
  subsec256: Math.min(Math.round(((timeMs % 1000) * 256) / 1000), 255),
});

/**
 * The readout as the serial card decoders report it: start, finish, check and
 * clear records, the reserve records as startFirst/finishFirst, and controls
 * as punches. Punches of type 0 (undefined) are left out; they stay in the
 * readout.
 */
export const toRaceResult = (readout: ReaderBtReadout): IRaceResultData => {
  const result: IRaceResultData = { cardNumber: readout.cardNumber, punches: [] };
  for (const p of readout.punches) {
    const { time, weekdayRaw, subsec256 } = clock(p.timeMs);
    switch (p.type) {
      case PUNCH_TYPE.control: {
        const punch: IPunch = { code: p.code, time, weekdayRaw };
        result.punches!.push(punch);
        break;
      }
      case PUNCH_TYPE.start:
        Object.assign(result, { startTime: time, startCode: p.code, startWeekdayRaw: weekdayRaw });
        if (subsec256) result.startSubsec256 = subsec256;
        break;
      case PUNCH_TYPE.finish:
        Object.assign(result, {
          finishTime: time,
          finishCode: p.code,
          finishWeekdayRaw: weekdayRaw,
        });
        if (subsec256) result.finishSubsec256 = subsec256;
        break;
      case PUNCH_TYPE.check:
        Object.assign(result, { checkTime: time, checkCode: p.code, checkWeekdayRaw: weekdayRaw });
        break;
      case PUNCH_TYPE.clear:
        Object.assign(result, { clearTime: time, clearWeekdayRaw: weekdayRaw });
        break;
      case PUNCH_TYPE.startReserve:
        Object.assign(result, { startFirstTime: time, startFirstCode: p.code });
        if (subsec256) result.startFirstSubsec256 = subsec256;
        break;
      case PUNCH_TYPE.finishReserve:
        Object.assign(result, { finishFirstTime: time, finishFirstCode: p.code });
        if (subsec256) result.finishFirstSubsec256 = subsec256;
        break;
    }
  }
  return result;
};
