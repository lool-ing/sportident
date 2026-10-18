// Authored for lool. Not ported from upstream.
//
// lool-readout keeps reading after a failed card read or a serial-port
// error: one bad card must not end readout for the day.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { wireReadout } from './lool-readout.ts';
import { NdjsonEmitter } from '../output/ndjson.ts';
import type { SiMainStation } from '../SiStation/SiMainStation.ts';
import type { ISerialTransport } from '../transport/ISerialTransport.ts';
import { DeviceClosedError } from '../transport/errors.ts';
import { SiCard9 } from '../SiCard/types/SiCard9.ts';
import { fixture as si9 } from '../../tests/fixtures/upstream/si9-typical.ts';

test('a failed card read and a transport error are reported; the next card is still emitted; a device close exits 3', () => {
  const station = new EventEmitter();
  const transport = new EventEmitter();
  const lines: string[] = [];
  const emitter = new NdjsonEmitter({ device_path: '/dev/test', out: (l) => lines.push(l) });
  const shutdowns: number[] = [];
  wireReadout(
    station as unknown as SiMainStation,
    transport as unknown as ISerialTransport,
    emitter,
    { once: false },
    async (code) => void shutdowns.push(code)
  );

  station.emit('error', new Error('card removed during read'));
  transport.emit('error', new Error('EIO'));
  const card = new SiCard9(si9.cardData.cardNumber as number);
  card.decodeFromStorage(si9.storageData);
  station.emit('cardRead', card);

  const events = lines.map((l) => JSON.parse(l) as { event: string; error?: string });
  assert.deepStrictEqual(
    events.map((e) => [e.event, e.error]),
    [
      ['connection_changed', 'card removed during read'],
      ['connection_changed', 'EIO'],
      ['card_read', undefined],
    ]
  );
  assert.deepStrictEqual(shutdowns, [], 'readout keeps running');

  // The device going away mid-read is the one error that ends readout.
  station.emit('error', new DeviceClosedError('transport closed mid-flight'));
  assert.deepStrictEqual(shutdowns, [3]);
});

test('an unsupported card gives a card_unsupported line', () => {
  const station = new EventEmitter();
  const lines: string[] = [];
  const emitter = new NdjsonEmitter({ device_path: '/dev/test', out: (l) => lines.push(l) });
  wireReadout(
    station as unknown as SiMainStation,
    new EventEmitter() as unknown as ISerialTransport,
    emitter,
    { once: false },
    async () => undefined
  );
  station.emit('cardUnsupported', { cardNumber: 3_500_000, command: 0xe8, seriesByte: 0x0f });
  const e = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepStrictEqual(
    [e.event, e.card_number, e.detect_command, e.card_series_byte],
    ['card_unsupported', 3_500_000, 0xe8, 0x0f]
  );
});
