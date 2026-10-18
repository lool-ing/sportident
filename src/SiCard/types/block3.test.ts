// Authored for lool. Not ported from upstream.
//
// SIAC block 3 (page 3): battery voltage and hardware/software version.
// Evidence: battery byte 0x1C7 and 1.9 V + n × 0.09 V, over 5 V invalid:
// MeOS SportIdent.cpp:1490-1497; the same byte and formula, and versions at
// 0x1C0-0x1C3 (major, minor): SPORTident.Communication 2.59.0, black-box byte
// sweep of siac-bench-001, 2026-10-08. The library reads block 3 on SIAC.
// Battery date: page 0x6F = bytes 0x1bc-0x1be yy mm dd, 0x1bf character set
// (SPORTident card data structure, provided on request). Binary, year 2000 +
// yy: the same sheet gives the SIAC production year as "after 2000", and
// SPORTident.Communication 2.59.0 reads 18 05 0F as 2024-05-15 and BCD
// 24 05 15 as 1936-05-21 (synthetic SIAC images, 2026-10-14).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../../constants.ts';
import type { SiMessage } from '../../siProtocol.ts';
import { NdjsonEmitter } from '../../output/ndjson.ts';
import { SIAC } from './SIAC.ts';
import { SiCard10 } from './SiCard10.ts';

const BYTES_PER_PAGE = 128;

function makeMemory(block3: Record<number, number> = {}): number[] {
  const mem = new Array<number>(0x400).fill(0xee);
  const holder = ';;;;;;;;;;;';
  for (let i = 0; i < holder.length; i++) mem[0x20 + i] = holder.charCodeAt(i);
  mem[0x16] = 0;
  for (const [offset, value] of Object.entries(block3)) mem[Number(offset)] = value;
  return mem;
}

const date = (yy: number, mm: number, dd: number) => ({ 0x1bc: yy, 0x1bd: mm, 0x1be: dd });

async function read<T extends SIAC | SiCard10>(
  Card: new (n: number) => T,
  mem: number[]
): Promise<{ card: T; pages: number[] }> {
  const card = new Card(0);
  const pages: number[] = [];
  card.mainStation = {
    sendMessage: async (msg: SiMessage) => {
      if (msg.mode !== undefined) return [];
      const page = msg.parameters[0]!;
      pages.push(page);
      const data = mem.slice(page * BYTES_PER_PAGE, (page + 1) * BYTES_PER_PAGE);
      return [[proto.cmd.GET_SI8, BYTES_PER_PAGE + 3, 0x00, 0x0a, page, ...data]];
    },
  } as unknown as NonNullable<SIAC['mainStation']>;
  await card.typeSpecificRead();
  return { card, pages };
}

describe('SIAC block 3: battery and versions', () => {
  test('SIAC reads page 3 right after page 0; SI10 does not read it', async () => {
    assert.deepEqual((await read(SIAC, makeMemory())).pages, [0, 3, 1]);
    assert.deepEqual((await read(SiCard10, makeMemory())).pages, [0]);
  });

  test('battery 1900 + 90 × n mV: 0 → 1900, 12 → 2980, 34 → 4960; 35 (5050) and 0xEE give none', async () => {
    for (const [n, mv] of [
      [0, 1900],
      [12, 2980],
      [34, 4960],
      [35, undefined],
      [0xee, undefined],
    ] as const) {
      const { card } = await read(SIAC, makeMemory({ 0x1c7: n }));
      assert.equal(card.raceResult.batteryMillivolts, mv, `n=${n}`);
    }
  });

  test('versions are major.minor from 0x1c0/0x1c1 and 0x1c2/0x1c3; erased gives none', async () => {
    const { card } = await read(SIAC, makeMemory({ 0x1c0: 2, 0x1c1: 1, 0x1c2: 5, 0x1c3: 7 }));
    assert.equal(card.raceResult.hardwareVersion, '2.1');
    assert.equal(card.raceResult.softwareVersion, '5.7');
    const erased = await read(SIAC, makeMemory());
    assert.equal(erased.card.raceResult.hardwareVersion, undefined);
    assert.equal(erased.card.raceResult.softwareVersion, undefined);
  });

  test('battery date is 2000 + yy, binary; the character-set byte is not part of it', async () => {
    const { card } = await read(SIAC, makeMemory({ ...date(0x18, 0x05, 0x0f), 0x1bf: 0x01 }));
    assert.equal(card.raceResult.batteryDate, '2024-05-15');
  });

  test('battery date: 29 February only in a leap year', async () => {
    assert.equal(
      (await read(SIAC, makeMemory(date(24, 2, 29)))).card.raceResult.batteryDate,
      '2024-02-29'
    );
    assert.equal(
      (await read(SIAC, makeMemory(date(23, 2, 29)))).card.raceResult.batteryDate,
      undefined
    );
  });

  test('battery date unknown for an invalid month or day, erased bytes, or a year after now', async () => {
    for (const bytes of [
      date(24, 0, 1),
      date(24, 13, 1),
      date(24, 5, 0),
      date(24, 4, 31),
      date(0xee, 0xee, 0xee),
      date(24, 5, 0xee),
      date(99, 1, 1),
    ]) {
      const { card } = await read(SIAC, makeMemory(bytes));
      assert.equal(card.raceResult.batteryDate, undefined, JSON.stringify(bytes));
    }
  });

  test('battery date unknown without block 3, and SI10 has none', async () => {
    const siac = new SIAC(0);
    siac._decodeFromStorage(makeMemory(date(24, 5, 15)).slice(0, BYTES_PER_PAGE));
    assert.equal(siac.raceResult.batteryDate, undefined);
    const { card } = await read(SiCard10, makeMemory(date(24, 5, 15)));
    assert.equal(card.raceResult.batteryDate, undefined);
  });

  test('card_read carries battery_mv and versions only when known', async () => {
    const lines: string[] = [];
    const emitter = new NdjsonEmitter({ device_path: 'mock', out: (l) => lines.push(l) });
    const { card } = await read(
      SIAC,
      makeMemory({ 0x1c7: 12, 0x1c0: 2, 0x1c1: 1, 0x1c2: 5, 0x1c3: 7, ...date(24, 5, 15) })
    );
    emitter.card_read({ card });
    const { card: blank } = await read(SIAC, makeMemory());
    emitter.card_read({ card: blank });
    const [full, empty] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(full!.battery_mv, 2980);
    assert.equal(full!.hardware_version, '2.1');
    assert.equal(full!.software_version, '5.7');
    assert.equal(full!.battery_date, '2024-05-15');
    for (const key of ['battery_mv', 'hardware_version', 'software_version', 'battery_date'])
      assert.equal(key in empty!, false, key);
  });
});
