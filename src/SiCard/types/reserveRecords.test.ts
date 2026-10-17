// Authored for lool. Not ported from upstream.
//
// SIAC reserve records start_r / finish_r (block 3, byte 0x1d8 / 0x1dc; page
// 0x76 / 0x77 in the SPORTident card data structure, provided on request, which
// gives them the same 4-byte layout as the main start/finish records). The
// reserve is written by the first punch after a clear; the main record holds
// the last (SPORTident (Thomas, 2026-10-13)). Observation only: the reader
// reports both. A reserve record with PTD bit 7 has a subsecond in CN and an
// unknown code (open question to SPORTident); block 1 holds the main record's
// code only and must not be borrowed for it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../../constants.ts';
import type { SiMessage } from '../../siProtocol.ts';
import { SIAC } from './SIAC.ts';
import { SiCard10 } from './SiCard10.ts';

const BYTES_PER_PAGE = 128;
const START = 0x0c;
const FINISH = 0x10;
const START_R = 0x1d8;
const FINISH_R = 0x1dc;

function makeMemory(): number[] {
  const mem = new Array<number>(0x400).fill(0xee);
  const holder = ';;;;;;;;;;;';
  for (let i = 0; i < holder.length; i++) mem[0x20 + i] = holder.charCodeAt(i);
  mem[0x16] = 0;
  [mem[0x1c2], mem[0x1c3]] = [4, 0];
  return mem;
}

/** A record [ptd, cn, th, tl] with the time in seconds. */
function setRecord(mem: number[], offset: number, ptd: number, cn: number, sec: number): void {
  mem.splice(offset, 4, ptd, cn, sec >> 8, sec & 0xff);
}

async function read(Card: new (n: number) => SIAC | SiCard10, mem: number[]) {
  const card = new Card(0);
  card.mainStation = {
    sendMessage: async (msg: SiMessage) => {
      if (msg.mode !== undefined) return [];
      const page = msg.parameters[0]!;
      const data = mem.slice(page * BYTES_PER_PAGE, (page + 1) * BYTES_PER_PAGE);
      return [[proto.cmd.GET_SI8, BYTES_PER_PAGE + 3, 0x00, 0x0a, page, ...data]];
    },
  } as unknown as NonNullable<SIAC['mainStation']>;
  await card.typeSpecificRead();
  return card.raceResult;
}

describe('SIAC reserve records: first start/finish punch', () => {
  test('first and last differ: both are reported, the main record untouched', async () => {
    const mem = makeMemory();
    setRecord(mem, START, 0x00, 3, 36_000);
    setRecord(mem, START_R, 0x40, 3, 35_990); // PTD bit 6: code 259
    setRecord(mem, FINISH, 0x00, 20, 37_000);
    mem[0xa9] = 20;
    setRecord(mem, FINISH_R, 0x00, 20, 36_900);
    const r = await read(SIAC, mem);
    assert.equal(r.startTime, 36_000);
    assert.equal(r.finishTime, 37_000);
    assert.equal(r.startFirstTime, 35_990);
    assert.equal(r.startFirstCode, 259);
    assert.equal(r.startFirstSubsec256, undefined);
    assert.equal(r.finishFirstTime, 36_900);
    assert.equal(r.finishFirstCode, 20);
  });

  test('first and last equal: both reported, equal', async () => {
    const mem = makeMemory();
    setRecord(mem, FINISH, 0x00, 20, 37_000);
    setRecord(mem, FINISH_R, 0x00, 20, 37_000);
    const r = await read(SIAC, mem);
    assert.equal(r.finishFirstTime, r.finishTime);
    assert.equal(r.finishFirstCode, 20);
    assert.equal(r.startFirstTime, null);
  });

  test('an empty (erased) reserve record: null, never "same as main", no code or fraction', async () => {
    const mem = makeMemory();
    setRecord(mem, FINISH, 0x00, 20, 37_000);
    const r = await read(SIAC, mem);
    assert.equal(r.finishTime, 37_000);
    for (const k of ['startFirst', 'finishFirst'] as const) {
      assert.equal(r[`${k}Time`], null);
      assert.equal(r[`${k}Code`], undefined);
      assert.equal(r[`${k}Subsec256`], undefined);
    }
  });

  test('block 3 not read: the reserve is absent, not empty', () => {
    const mem = makeMemory();
    setRecord(mem, FINISH, 0x00, 20, 37_000);
    setRecord(mem, FINISH_R, 0x00, 20, 36_900);
    const card = new SIAC(0);
    card._decodeFromStorage(mem.slice(0, 3 * BYTES_PER_PAGE)); // blocks 0-2 only
    const r = card.raceResult;
    assert.equal(r.finishTime, 37_000);
    for (const k of ['startFirst', 'finishFirst'] as const) {
      assert.equal(k + 'Time' in r, false);
      assert.equal(r[`${k}Code`], undefined);
      assert.equal(r[`${k}Subsec256`], undefined);
    }
  });

  test('a reserve record with PTD bit 7: subsecond, no code, main block-1 code not borrowed', async () => {
    const mem = makeMemory();
    setRecord(mem, FINISH, 0x80, 200, 37_000);
    mem[0xa9] = 20;
    setRecord(mem, FINISH_R, 0x80, 117, 36_900);
    const r = await read(SIAC, mem);
    assert.equal(r.finishCode, 20);
    assert.equal(r.finishSubsec256, 200);
    assert.equal(r.finishFirstTime, 36_900);
    assert.equal(r.finishFirstSubsec256, 117);
    assert.equal(r.finishFirstCode, undefined);
  });

  test('SI10 has no reserve records: block 3 is not read, bytes at 0x1d8 are ignored', async () => {
    const mem = makeMemory();
    setRecord(mem, FINISH, 0x00, 20, 37_000);
    setRecord(mem, FINISH_R, 0x00, 20, 36_900);
    const r = await read(SiCard10, mem);
    assert.equal(r.finishFirstTime, undefined);
  });
});
