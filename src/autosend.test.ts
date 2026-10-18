// Authored for lool. Not ported from upstream.
// Tests for the autosend record decoder and the
// listen-only AutosendListener. Frames are built by hand; card numbers are
// made up.
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { AutosendListener, decodeAutosendRecord, type AutosendPunch } from './autosend.ts';
import { proto } from './constants.ts';
import { render } from './siProtocol.ts';
import type { ISerialTransport } from './transport/ISerialTransport.ts';

/** CN1 CN0 SN3 SN2 SN1 SN0 TD TH TL TSS MEM2 MEM1 MEM0. */
const record = (o: {
  code: number;
  sn: [number, number, number, number];
  td: number;
  seconds: number;
  tss?: number;
  mem?: number;
}): number[] => [
  o.code >> 8,
  o.code & 0xff,
  ...o.sn,
  o.td,
  o.seconds >> 8,
  o.seconds & 0xff,
  o.tss ?? 0,
  ((o.mem ?? 0) >> 16) & 0xff,
  ((o.mem ?? 0) >> 8) & 0xff,
  (o.mem ?? 0) & 0xff,
];

const frame = (parameters: number[], command: number = proto.cmd.TRANS_REC): number[] =>
  render({ command, parameters });

// 8 123 456 = 0x7BF440; 10:15:30 = 36930 s.
const SIAC_AM = record({
  code: 78,
  sn: [0x00, 0x7b, 0xf4, 0x40],
  td: 0b0000_0000,
  seconds: 36930,
  tss: 128,
  mem: 0x000208,
});

describe('decodeAutosendRecord', () => {
  test('code, card, morning time, subsecond and backup address', () => {
    assert.deepEqual(decodeAutosendRecord(SIAC_AM), {
      code: 78,
      card_number: 8123456,
      clock: {
        seconds_in_half_day: 36930,
        half_day: 0,
        weekday: 0,
        weekday_raw: 0,
        subsec_256: 128,
      },
      mem_address: 0x208,
    });
  });

  test('afternoon bit and weekday', () => {
    // TD: Saturday (110b) in bits 3..1, pm in bit 0.
    const p = decodeAutosendRecord(
      record({ code: 100, sn: [0, 0x7b, 0xf4, 0x40], td: 0b0000_1101, seconds: 3600 })
    );
    assert.deepEqual(p?.clock, {
      seconds_in_half_day: 3600,
      half_day: 1,
      weekday: 6,
      weekday_raw: 6,
      subsec_256: 0,
    });
  });

  test('weekday 7 (not set): weekday null, as in card_read, and weekday_raw 7', () => {
    const p = decodeAutosendRecord(
      record({ code: 100, sn: [0, 0x7b, 0xf4, 0x40], td: 0b0000_1110, seconds: 3600 })
    );
    assert.equal(p?.clock.weekday, null);
    assert.equal(p?.clock.weekday_raw, 7);
  });

  test('SI-Card 5: series byte times 100000 plus the number', () => {
    // Series 2, number 34567 = 0x8707.
    const p = decodeAutosendRecord(
      record({ code: 31, sn: [0, 2, 0x87, 0x07], td: 0, seconds: 100 })
    );
    assert.equal(p?.card_number, 234567);
  });

  test('a longer record is decoded from its first 13 bytes', () => {
    assert.equal(decodeAutosendRecord([...SIAC_AM, 0x02, 0x05])?.card_number, 8123456);
  });

  test('too short, or a time that is no time of day: null', () => {
    assert.equal(decodeAutosendRecord(SIAC_AM.slice(0, 12)), null);
    assert.equal(
      decodeAutosendRecord(record({ code: 31, sn: [0, 0, 1, 2], td: 0, seconds: 0xeeee })),
      null
    );
  });
});

class FakeTransport extends EventEmitter implements ISerialTransport {
  sent: number[][] = [];
  open(): Promise<void> {
    return Promise.resolve();
  }
  send(bytes: number[]): Promise<void> {
    this.sent.push(bytes);
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const listen = (staleMs?: number) => {
  const transport = new FakeTransport();
  const listener = new AutosendListener(transport, staleMs === undefined ? {} : { staleMs });
  const punches: AutosendPunch[] = [];
  listener.on('punch', (p) => punches.push(p));
  return { transport, listener, punches };
};

describe('AutosendListener', () => {
  test('emits a punch per record and never sends', () => {
    const { transport, listener, punches } = listen();
    transport.emit('data', [proto.WAKEUP, ...frame(SIAC_AM), ...frame(SIAC_AM)]);
    assert.equal(punches.length, 2);
    assert.equal(punches[0]?.code, 78);
    assert.equal(listener.counts.punches, 2);
    assert.deepEqual(transport.sent, []);
  });

  test('a record split over two chunks', () => {
    const { transport, punches } = listen();
    const bytes = frame(SIAC_AM);
    transport.emit('data', bytes.slice(0, 7));
    assert.equal(punches.length, 0);
    transport.emit('data', bytes.slice(7));
    assert.equal(punches.length, 1);
  });

  test('a bad CRC is counted and the next record still arrives', () => {
    const { transport, listener, punches } = listen();
    const bad = frame(SIAC_AM);
    bad[6] = (bad[6] as number) ^ 0xff;
    const errors: string[] = [];
    listener.on('frameError', (e) => errors.push(e.error_code));
    transport.emit('data', [...bad, ...frame(SIAC_AM)]);
    assert.equal(punches.length, 1);
    assert.equal(listener.counts.frame_errors, 1);
    assert.deepEqual(errors, ['crc_mismatch']);
  });

  test('a record whose own bytes look like a small frame survives any split', () => {
    // SN0 TD TH TL TSS MEM2 = 02 28 00 28 00 03: STX, a command, length 0,
    // its two-byte CRC and ETX. Whole, the record decodes; the listener must
    // not take those six bytes for a frame when the record arrives in two
    // chunks.
    const tricky = record({
      code: 78,
      sn: [0x00, 0x7b, 0xf4, 0x02],
      td: 0x28,
      seconds: 0x0028,
      tss: 0,
      mem: 0x030000,
    });
    assert.equal(decodeAutosendRecord(tricky)?.card_number, 8123394);
    const bytes = frame(tricky);
    for (let cut = 1; cut < bytes.length; cut++) {
      const { transport, punches } = listen();
      transport.emit('data', bytes.slice(0, cut));
      transport.emit('data', bytes.slice(cut));
      assert.equal(punches.length, 1, `split after byte ${cut}`);
    }
  });

  test('a stray STX does not swallow the records after it', async () => {
    // STX, a command and a length byte of 40: the parser waits for 46 bytes
    // and would take the real records as that frame's data. When no more
    // bytes come, the records inside are found.
    const { transport, listener, punches } = listen(10);
    transport.emit('data', [proto.STX, 0x99, 40, ...frame(SIAC_AM), ...frame(SIAC_AM)]);
    assert.equal(punches.length, 0);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(punches.length, 2);
    listener.stop();
  });

  test('a stray STX whose false frame fills up loses no record either', () => {
    // 46 bytes are there at once: the false frame fails its CRC and the
    // records inside it are found straight away.
    const { transport, punches } = listen();
    transport.emit('data', [
      proto.STX,
      0x99,
      40,
      ...frame(SIAC_AM),
      ...frame(SIAC_AM),
      ...frame(SIAC_AM),
    ]);
    assert.equal(punches.length, 3);
  });

  test('a half frame that never completes is dropped after staleMs', async () => {
    const { transport, listener, punches } = listen(10);
    transport.emit('data', [proto.STX, 0x99, 200, 1, 2, 3]);
    await new Promise((r) => setTimeout(r, 40));
    transport.emit('data', frame(SIAC_AM));
    assert.equal(punches.length, 1);
    assert.equal(listener.counts.frame_errors, 1);
    listener.stop();
  });

  test('other commands, the SIAC indicator card and card 0 are not punches', () => {
    const { transport, listener, punches } = listen();
    transport.emit('data', [
      ...frame([0, 1, 0, 0, 0, 0], proto.cmd.SRR_PING),
      // 8 000 000 = 0x7A1200.
      ...frame(record({ code: 78, sn: [0, 0x7a, 0x12, 0x00], td: 0, seconds: 100 })),
      ...frame(record({ code: 78, sn: [0, 0, 0, 0], td: 0, seconds: 100 })),
    ]);
    assert.equal(punches.length, 0);
    assert.equal(listener.counts.ignored, 3);
  });

  test('a base-protocol record (legacy protocol left on) is counted', async () => {
    const { transport, listener, punches } = listen(10);
    // Base protocol has no length byte or CRC: STX, 0x53, data, ETX.
    transport.emit('data', [proto.STX, proto.basicCmd.TRANS_REC, 78, 0, 1, 2, 3, 4, proto.ETX]);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(punches.length, 0);
    assert.equal(listener.counts.legacy_records, 1);
    listener.stop();
  });
});
