// Authored for lool. Not ported from upstream.
//
// Autosend ("online control") records. A station with "auto send" and
// "extended protocol" switched on sends one 0xD3 frame per punch without
// being asked (SPORTident PC Programmer's Guide 5, chapter 5): station code,
// card number, a day/half-day byte, the 12 h time, 1/256 s and the address of
// the record in the station's backup memory. A radio gateway that passes the
// stations' bytes through unchanged (jSh.Radio, an SRR receiver) delivers the
// same frames on its serial port.
//
// AutosendListener only listens. It never calls transport.send(), so it can
// sit on a gateway that is no SI station and answers no commands.
// See NOTICE.md for cumulative attribution.

import { EventEmitter } from 'node:events';

import { proto } from './constants.ts';
import type { HalfDayClock } from './output/ndjson.ts';
import { arr2cardNumber, dayOfWeekFromRaw, nextFrameStart, parse, SI_TIME_CUTOFF } from './siProtocol.ts';
import type { FrameError, SiMessage } from './siProtocol.ts';
import type { ISerialTransport } from './transport/ISerialTransport.ts';
import type { TypedEventEmitter } from './utils/events.ts';

export interface AutosendPunch {
  /** The station's programmed code number. */
  code: number;
  card_number: number;
  /** The station's clock at the punch; weekday and subsec_256 are set. */
  clock: HalfDayClock;
  /** Address of the record in the station's backup memory. The guide calls
   * it a record number: a gap between two records from one station means
   * records were lost on the way. */
  mem_address: number;
}

/** Bytes of the record the guide defines; a longer record (jSh's variant
 * with the station mode) starts with the same 13. */
const RECORD_LEN = 13;

/** The data of a 0xD3 frame → punch; null when it is too short or its time
 * is no time of day. */
export const decodeAutosendRecord = (parameters: number[]): AutosendPunch | null => {
  if (parameters.length < RECORD_LEN) return null;
  const [cn1, cn0, sn3, sn2, sn1, sn0, td, th, tl, tss, mem2, mem1, mem0] = parameters as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const seconds = (th << 8) | tl;
  const card = arr2cardNumber([sn0, sn1, sn2, sn3]);
  if (seconds >= SI_TIME_CUTOFF || card === undefined) return null;
  return {
    code: (cn1 << 8) | cn0,
    card_number: card,
    clock: {
      seconds_in_half_day: seconds,
      half_day: (td & 1) as 0 | 1,
      // Same meaning as in card_read: 0-6, null for 7 (not set), raw kept.
      weekday: dayOfWeekFromRaw((td >> 1) & 0b111),
      weekday_raw: (td >> 1) & 0b111,
      subsec_256: tss,
    },
    mem_address: (mem2 << 16) | (mem1 << 8) | mem0,
  };
};

/** A SIAC announcing itself, not a punch (it carries no valid time). */
const SIAC_INDICATOR_CARD = 8000000;

export interface AutosendCounts {
  punches: number;
  /** Whole frames that are no punch: other commands, the SIAC indicator,
   * card number 0 (a light-beam trigger), an undecodable record. */
  ignored: number;
  /** Bad CRC or ETX, and bytes given up on. */
  frame_errors: number;
  /** Given-up bytes that start like a base-protocol record (0x53): a
   * station still has "legacy protocol" on. */
  legacy_records: number;
}

type AutosendEvents = {
  punch: (punch: AutosendPunch) => void;
  frameError: (err: FrameError) => void;
};

export interface AutosendListenerOpts {
  /** A half frame with no new bytes for this long is given up on (default
   * 1 s; a whole frame takes under 0.1 s at 38400 baud). */
  staleMs?: number;
}

export class AutosendListener extends (EventEmitter as new () => TypedEventEmitter<AutosendEvents> &
  EventEmitter) {
  readonly counts: AutosendCounts = { punches: 0, ignored: 0, frame_errors: 0, legacy_records: 0 };
  private buffer: number[] = [];
  private staleTimer: NodeJS.Timeout | null = null;
  private readonly staleMs: number;
  private readonly transport: ISerialTransport;
  private readonly onData = (bytes: number[]): void => {
    this.buffer = this.buffer.concat(bytes);
    this.drain();
  };

  constructor(transport: ISerialTransport, opts: AutosendListenerOpts = {}) {
    super();
    this.transport = transport;
    this.staleMs = opts.staleMs ?? 1000;
    transport.on('data', this.onData);
  }

  /** Stop listening (the transport is the caller's to close). */
  stop(): void {
    (this.transport as unknown as EventEmitter).off('data', this.onData);
    this.clearStaleTimer();
    this.buffer = [];
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }

  private drain(): void {
    this.clearStaleTimer();
    for (;;) {
      const buf = this.buffer;
      const r = parse(buf);
      if (r.badFrame) {
        const bf = r.badFrame;
        // A stray STX can make later, whole frames look like this frame's
        // data: continue at the first whole frame inside it, if there is one.
        const next = bf.code === 'crc_mismatch' ? nextFrameStart(buf) : -1;
        const consumed = next > 0 && next < bf.bytesConsumed ? next : bf.bytesConsumed;
        this.giveUp(bf.code, buf.slice(0, consumed));
        this.buffer = buf.slice(consumed);
        continue;
      }
      if (r.message) {
        this.handle(r.message);
        this.buffer = r.remainder;
        continue;
      }
      if (r.remainder.length < buf.length) {
        // A byte that starts nothing.
        this.buffer = r.remainder;
        continue;
      }
      // An unfinished frame at the head: wait for the rest. Its bytes are
      // not searched for frames yet; a real record can hold bytes that look
      // like a small frame.
      break;
    }
    if (this.buffer.length > 0) {
      this.staleTimer = setTimeout(() => {
        this.staleTimer = null;
        // The rest never came, so the head was noise. Go on at the first
        // whole frame inside it, if there is one.
        const buf = this.buffer;
        const next = nextFrameStart(buf);
        const consumed = next > 0 ? next : buf.length;
        this.giveUp('truncated', buf.slice(0, consumed));
        this.buffer = buf.slice(consumed);
        this.drain();
      }, this.staleMs);
    }
  }

  private giveUp(code: FrameError['error_code'], bytes: number[]): void {
    this.counts.frame_errors++;
    if (bytes[0] === proto.STX && bytes[1] === proto.basicCmd.TRANS_REC) {
      this.counts.legacy_records++;
    }
    this.emit('frameError', {
      error_code: code,
      raw_bytes: bytes,
      bytes_consumed: bytes.length,
    });
  }

  private handle(message: SiMessage): void {
    // Wake-up, ACK and NAK bytes carry nothing.
    if (!('command' in message)) return;
    const punch =
      message.command === proto.cmd.TRANS_REC ? decodeAutosendRecord(message.parameters) : null;
    if (punch === null || punch.card_number === 0 || punch.card_number === SIAC_INDICATOR_CARD) {
      this.counts.ignored++;
      return;
    }
    this.counts.punches++;
    this.emit('punch', punch);
  }
}
