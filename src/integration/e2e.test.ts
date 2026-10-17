// Authored for lool. Not ported from upstream.
// End-to-end fixture-replay test.
//
// Closes the loop: synthetic bytes IN -> SiMainStation pipeline (multiplexer,
// transport, station, BaseSiCard registry) -> NDJSON line OUT. Zero hardware
// dependency: a FakeSerialTransport replays canned handshake responses + the
// upstream SI5 fixture as a GET_SI5 reply, and we capture the NdjsonEmitter
// output via `out` injection.
//
// Asserts the 3-line NDJSON sequence (connection_changed/state=open,
// card_inserted, card_read) with the punches from the fixture flowing through
// to the snake_case schema unmodified.
//
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { render } from '../siProtocol.ts';
import { proto } from '../constants.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { SiMainStation } from '../SiStation/SiMainStation.ts';
import { STATION_CONFIG_OFFSETS, StationMode } from '../SiStation/BaseSiStation.ts';
import { NdjsonEmitter } from '../output/ndjson.ts';
import type { BaseSiCard } from '../SiCard/BaseSiCard.ts';
import type { FrameError } from '../siProtocol.ts';

import { fixture as si5Fixture } from '../../tests/fixtures/upstream/si5-16-punches.ts';

// ---------------------------------------------------------------------------
// FakeSerialTransport — minimal copy of the SiMainStation.test.ts helper. We
// duplicate the small class here (rather than export it from the test file)
// so e2e.test.ts has zero dependencies on test scaffolding.
// ---------------------------------------------------------------------------

type SendMatcher = (chunk: number[]) => boolean;
type SendHandler = (chunk: number[]) => number[] | void;

class FakeSerialTransport extends EventEmitter implements ISerialTransport {
  public recordedSends: number[][] = [];
  private rules: { matcher: SendMatcher; handler: SendHandler }[] = [];
  private closed = false;

  open(): Promise<void> {
    return Promise.resolve();
  }

  send(bytes: number[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('FakeSerialTransport closed'));
    this.recordedSends.push(bytes);
    const rule = this.rules.find((r) => r.matcher(bytes));
    if (rule) {
      const resp = rule.handler(bytes);
      if (resp !== undefined) setImmediate(() => this.emit('data', resp));
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    setImmediate(() => this.emit('close'));
    return Promise.resolve();
  }

  addRule(matcher: SendMatcher, handler: SendHandler): void {
    this.rules.push({ matcher, handler });
  }

  inject(bytes: number[]): void {
    setImmediate(() => this.emit('data', bytes));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderFrame = (command: number, parameters: number[]): number[] =>
  render({ command, parameters });

const makeStationConfigBlob = (): number[] => {
  const cfg = new Array<number>(128).fill(0x00);
  // Pre-handshake state: Workstation mode, code=1. Handshake-flag bits
  // (0x73/0x74) stay 0x00 — e2e tests don't assert bit-merge semantics
  // (that's covered in SiMainStation.test.ts); they just need the handshake
  // to complete without errors so end-to-end card flows can run.
  cfg[STATION_CONFIG_OFFSETS.MODE] = StationMode.Workstation;
  cfg[STATION_CONFIG_OFFSETS.CODE_LOW] = 1;
  return cfg;
};

const setUpHandshakeRules = (fake: FakeSerialTransport): void => {
  fake.addRule(
    (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.SET_MS,
    // Real-wire SET_MS response: [addr_hi, addr_lo, P_MS_DIRECT] (bench
    // 2026-05-13: 02 F0 03 00 0A 4D ...). Station address = 0x000A.
    () => renderFrame(proto.cmd.SET_MS, [0x00, 0x0a, proto.P_MS_DIRECT])
  );
  fake.addRule(
    (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.GET_SYS_VAL,
    // Real-wire GET_SYS_VAL response: [addr_hi, addr_lo, offset_echo, ...128 data].
    // Bench 2026-05-13 captured this exact 131-byte shape from /dev/ttyUSB0
    // (02 83 83 00 0A 00 ...). Station address = 0x000A (code 10).
    () => renderFrame(proto.cmd.GET_SYS_VAL, [0x00, 0x0a, 0x00, ...makeStationConfigBlob()])
  );
  fake.addRule(
    (c) => c[0] === proto.WAKEUP && c[1] === proto.STX && c[2] === proto.cmd.SET_SYS_VAL,
    // Real-wire SET_SYS_VAL response: [addr_hi, addr_lo, offset_echo]. The
    // station ECHOES the offset written to.
    (c) => renderFrame(proto.cmd.SET_SYS_VAL, [0x00, 0x0a, c[4] as number])
  );
};

/** Build an SI5_DET frame for `cardNumber` using the same encoding that
 * detectFromMessage expects (params[3..5] = [mid, hi, lo] of the 100k-offset
 * decomposition for legacy SI5 cards). */
const buildSi5DetFrame = (cardNumber: number): number[] => {
  const mid = Math.floor(cardNumber / 100000) & 0xff;
  const residual = cardNumber - mid * 100000;
  const hi = (residual >> 8) & 0xff;
  const lo = residual & 0xff;
  return renderFrame(proto.cmd.SI5_DET, [0x00, 0x00, 0x00, mid, hi, lo]);
};

const renderGetSi5Response = (page128: number[]): number[] =>
  // Real-wire GET_SI5 response: [addr_hi, addr_lo, ...128 data]. Bench 2026-05-13
  // captured this 130-byte param shape. SiCard5.typeSpecificRead does
  // frame.slice(4) so the splice receives exactly 128 data bytes.
  renderFrame(proto.cmd.GET_SI5, [0x00, 0x0a, ...page128]);

// ---------------------------------------------------------------------------
// e2e tests
// ---------------------------------------------------------------------------

describe('e2e: fixture-replay through SiMainStation -> NDJSON', () => {
  test('SI5_DET + GET_SI5 -> 3 NDJSON lines (connection_changed/open, card_inserted, card_read)', async () => {
    const fake = new FakeSerialTransport();
    setUpHandshakeRules(fake);

    const station = new SiMainStation(fake);
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({
      device_path: '/dev/ttyUSB0',
      device_serial: '593656',
      out: (line) => lines.push(line),
    });

    // Wire all five SiMainStation events to NdjsonEmitter — the same call
    // graph bin/lool-readout.ts uses in production.
    station.on('connectionChanged', (state: 'opening' | 'open' | 'closed' | 'error') =>
      emitter.connection_changed({ state })
    );
    station.on('cardInserted', (card: BaseSiCard) => {
      emitter.card_inserted({
        card_type: 'SI5',
        card_number: card.cardNumber,
      });
    });
    station.on('cardRead', (card: BaseSiCard) => {
      emitter.card_read({ card });
    });
    station.on('cardRemoved', (cardNumber: number) =>
      emitter.card_removed({ card_number: cardNumber })
    );
    station.on('frameError', (err: FrameError) => emitter.frame_error(err));

    await fake.open();
    await station.readCards();

    // Wire the GET_SI5 reply to return the upstream SI5 fixture's 128-byte
    // storage page wrapped in the real-wire [addr_hi, addr_lo, ...128 data]
    // 130-byte param shape. SiCard5.typeSpecificRead does frame.slice(4) so
    // the splice receives exactly 128 data bytes after the [cmd,len,addr_hi,
    // addr_lo] response-header gets dropped.
    fake.addRule(
      (c) => c[0] === proto.WAKEUP && c[2] === proto.cmd.GET_SI5,
      () => renderGetSi5Response(si5Fixture.storageData as number[])
    );

    // Inject the SI5_DET frame and wait for the cardRead event to propagate.
    fake.inject(buildSi5DetFrame(si5Fixture.cardData.cardNumber));
    await new Promise((r) => setTimeout(r, 60));

    await station.close();

    // Extract events by `event` discriminator.
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // Sequence: connection_changed/opening, connection_changed/open, card_inserted, card_read, connection_changed/closed.
    const openEvent = events.find((e) => e.event === 'connection_changed' && e.state === 'open');
    const insertEvent = events.find((e) => e.event === 'card_inserted');
    const readEvent = events.find((e) => e.event === 'card_read');

    assert.ok(openEvent, 'connection_changed/open emitted');
    assert.strictEqual(openEvent!.device_path, '/dev/ttyUSB0');
    assert.strictEqual(openEvent!.device_serial, '593656');
    assert.strictEqual(openEvent!.schema_version, 1);

    assert.ok(insertEvent, 'card_inserted emitted');
    assert.strictEqual(insertEvent!.card_type, 'SI5');
    assert.strictEqual(insertEvent!.card_number, si5Fixture.cardData.cardNumber);

    assert.ok(readEvent, 'card_read emitted');
    assert.strictEqual(readEvent!.card_type, 'SI5');
    assert.strictEqual(readEvent!.card_number, si5Fixture.cardData.cardNumber);
    const expectedPunches = si5Fixture.cardData.punches as Array<{ code: number; time: number }>;
    assert.strictEqual(readEvent!.punch_count, expectedPunches.length);
    const actualPunches = readEvent!.punches as Array<Record<string, unknown>>;
    assert.strictEqual(actualPunches.length, expectedPunches.length);
    // Byte-equal punch comparison (codes + half-day clocks); all SI5 times in
    // this fixture are < SI_TIME_CUTOFF so half_day=0 across the board.
    for (let i = 0; i < expectedPunches.length; i++) {
      assert.strictEqual(actualPunches[i]!.code, expectedPunches[i]!.code);
      assert.strictEqual(actualPunches[i]!.seconds_in_half_day, expectedPunches[i]!.time);
      assert.strictEqual(actualPunches[i]!.half_day, 0);
      assert.strictEqual(actualPunches[i]!.weekday, null);
    }
    // Every line ends in exactly one '\n'.
    for (const line of lines) {
      assert.ok(line.endsWith('\n'));
      assert.ok(!line.endsWith('\n\n'));
    }
  });
});
