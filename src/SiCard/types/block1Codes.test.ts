// Authored for lool. Not ported from upstream.
//
// Start/finish station codes when PTD bit 7 is set. Bit 7 marks a subsecond:
// CN is then TSS and the code is lost there, for AIR+ and for contact punches
// from a station with subsecond timing alike. Only SIAC with firmware 4.0 or
// later keeps the code in block 1, 0xa5 (start) / 0xa9 (finish); 0x00 there
// means the code was lost; SI10/SI11 do not use those bytes; a check record
// keeps its code in CN. Source: SPORTident (Thomas, 2026-10-09), and the same
// behaviour from SPORTident.Communication 2.59.0 on our own card images
// (si-oracle, 2026-10-09; PTD bit 6 is not added to a block-1 code). The
// firmware version is read from block 3 (0x1c2, black-box sweep, 2026-10-08).
// Fake station serves pages from a synthetic memory image.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../../constants.ts';
import type { SiMessage } from '../../siProtocol.ts';
import { SIAC } from './SIAC.ts';
import { SiCard10 } from './SiCard10.ts';
import { SiCard8 } from './SiCard8.ts';
import { SiCard9 } from './SiCard9.ts';

const BYTES_PER_PAGE = 128;
const FINISH = 0x10;
const START = 0x0c;
const CHECK = 0x08;

/** A 0x400-byte card image: erased (0xee) except a complete card holder in
 * page 0, `punches` punch records at page 4, and the SIAC firmware version
 * (major.minor at 0x1c2/0x1c3) when given. */
function makeMemory(
  opts: { punches?: number; holderComplete?: boolean; firmware?: [number, number] | undefined } = {}
): number[] {
  const mem = new Array<number>(0x400).fill(0xee);
  const holder = opts.holderComplete === false ? 'A;B' : ';;;;;;;;;;;';
  for (let i = 0; i < holder.length; i++) mem[0x20 + i] = holder.charCodeAt(i);
  mem[0x16] = opts.punches ?? 0;
  for (let i = 0; i < (opts.punches ?? 0); i++)
    mem.splice(0x200 + 4 * i, 4, 0x01, 31 + i, 0x0e, 0x10);
  if (opts.firmware) [mem[0x1c2], mem[0x1c3]] = opts.firmware;
  return mem;
}

function setRecord(mem: number[], offset: number, ptd: number, cn: number): void {
  mem.splice(offset, 4, ptd, cn, 0x0e, 0x10);
}

type AnyCard = SIAC | SiCard10 | SiCard8 | SiCard9;

async function read(
  Card: new (n: number) => AnyCard,
  mem: number[]
): Promise<{ card: AnyCard; pages: number[] }> {
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
  } as unknown as NonNullable<SiCard10['mainStation']>;
  await card.typeSpecificRead();
  return { card, pages };
}

describe('SIAC firmware 4.0+: bit-7 start/finish codes from block 1', () => {
  test('bit-7 finish: page 1 is read after page 3 and 0xa9 is the code', async () => {
    const mem = makeMemory({ firmware: [4, 0] });
    setRecord(mem, FINISH, 0x81, 117); // CN is a subsecond
    mem[0xa9] = 20;
    const { card, pages } = await read(SIAC, mem);
    assert.deepEqual(pages, [0, 3, 1]);
    assert.equal(card.raceResult.finishCode, 20);
    assert.equal(card.raceResult.finishSubsec256, 117);
  });

  test('start from 0xa5; PTD bit 6 is not added to a block-1 code', async () => {
    const mem = makeMemory({ firmware: [5, 2] });
    setRecord(mem, START, 0x81, 0);
    setRecord(mem, FINISH, 0xc1, 0);
    mem[0xa5] = 13;
    mem[0xa9] = 10;
    const { card } = await read(SIAC, mem);
    assert.deepEqual([card.raceResult.startCode, card.raceResult.finishCode], [13, 10]);
  });

  test('0x00 in block 1 (contact punch with subsecond timing) and 0xee give no code', async () => {
    for (const byte of [0x00, 0xee]) {
      const mem = makeMemory({ firmware: [4, 0] });
      setRecord(mem, FINISH, 0x81, 0);
      mem[0xa9] = byte;
      const { card } = await read(SIAC, mem);
      assert.equal(card.raceResult.finishCode, undefined, `0x${byte.toString(16)}`);
    }
  });

  test('without bit 7 page 1 is still read and 0xa5 / 0xa9 are the codes (Thomas, 2026-10-13)', async () => {
    const mem = makeMemory({ firmware: [4, 0], punches: 2 });
    setRecord(mem, FINISH, 0x01, 20);
    setRecord(mem, START, 0x01, 3);
    mem[0xa5] = 13;
    mem[0xa9] = 99;
    const { card, pages } = await read(SIAC, mem);
    assert.deepEqual(pages, [0, 3, 1, 4]);
    assert.deepEqual([card.raceResult.startCode, card.raceResult.finishCode], [13, 99]);
  });

  test('without bit 7, 0x00 in block 1 still means no code', async () => {
    const mem = makeMemory({ firmware: [4, 0] });
    setRecord(mem, FINISH, 0x01, 20);
    mem[0xa9] = 0x00;
    const { card } = await read(SIAC, mem);
    assert.equal(card.raceResult.finishCode, undefined);
  });

  test('without bit 7, 0xee in block 1 keeps the record code (may be code 238: open question)', async () => {
    const mem = makeMemory({ firmware: [4, 0] });
    setRecord(mem, FINISH, 0x01, 238);
    mem[0xa9] = 0xee;
    const { card } = await read(SIAC, mem);
    assert.equal(card.raceResult.finishCode, 238);
  });

  test('no start or finish record: no page 1 is read', async () => {
    const mem = makeMemory({ firmware: [4, 0], punches: 2 });
    mem[0xa9] = 99;
    const { card, pages } = await read(SIAC, mem);
    assert.deepEqual(pages, [0, 3, 4]);
    assert.equal(card.raceResult.finishCode, undefined);
  });

  test('page 1 read once, before the punch pages, even with an incomplete card holder', async () => {
    const mem = makeMemory({ firmware: [4, 0], punches: 2, holderComplete: false });
    setRecord(mem, FINISH, 0x81, 0);
    mem[0xa9] = 20;
    const { card, pages } = await read(SIAC, mem);
    assert.deepEqual(pages, [0, 3, 1, 4]);
    assert.equal(card.raceResult.finishCode, 20);
  });

  test('erased records (0xee has bit 7 set) do not trigger a block-1 read', async () => {
    const { pages } = await read(SIAC, makeMemory({ firmware: [4, 0] }));
    assert.deepEqual(pages, [0, 3]);
  });

  test('a bit-7 check keeps CN + 256 × bit 6 (77, 333), never 0xa1, and reads no page 1', async () => {
    for (const [ptd, code] of [
      [0x81, 77],
      [0xc1, 333],
    ] as const) {
      const mem = makeMemory({ firmware: [4, 0] });
      setRecord(mem, CHECK, ptd, 77);
      mem[0xa1] = 99;
      const { card, pages } = await read(SIAC, mem);
      assert.deepEqual(pages, [0, 3]);
      assert.equal(card.raceResult.checkCode, code);
    }
  });
});

describe('bit-7 start/finish code is lost elsewhere', () => {
  test('SIAC firmware 3.9 or unknown (block 3 erased): no code, no page 1', async () => {
    for (const firmware of [[3, 9] as [number, number], undefined]) {
      const mem = makeMemory({ firmware });
      setRecord(mem, FINISH, 0x81, 117);
      mem[0xa9] = 20;
      const { card, pages } = await read(SIAC, mem);
      assert.deepEqual(pages, [0, 3], String(firmware));
      assert.equal(card.raceResult.finishCode, undefined);
      assert.equal(card.raceResult.finishSubsec256, 117);
    }
  });

  test('SIAC below 4.0 without bit 7: the record is its own code, no page 1', async () => {
    const mem = makeMemory({ firmware: [3, 9] });
    setRecord(mem, FINISH, 0x41, 20);
    mem[0xa9] = 99;
    const { card, pages } = await read(SIAC, mem);
    assert.deepEqual(pages, [0, 3]);
    assert.equal(card.raceResult.finishCode, 276);
  });

  test('SI10 without bit 7: the record is its own code, 0xa9 ignored, no page 1', async () => {
    const mem = makeMemory();
    setRecord(mem, FINISH, 0x01, 20);
    mem[0xa9] = 99;
    const { card, pages } = await read(SiCard10, mem);
    assert.deepEqual(pages, [0]);
    assert.equal(card.raceResult.finishCode, 20);
  });

  test('SI10: 0xa5 / 0xa9 are not used; bit 7 means no code, no page 1', async () => {
    const mem = makeMemory();
    setRecord(mem, FINISH, 0x81, 117);
    mem[0xa9] = 20;
    const { card, pages } = await read(SiCard10, mem);
    assert.deepEqual(pages, [0]);
    assert.equal(card.raceResult.finishCode, undefined);
  });

  for (const [name, Card] of [
    ['SI8', SiCard8],
    ['SI9', SiCard9],
  ] as const) {
    test(`${name}: block 1 holds punches; a bit-7 finish has no code and no punches means page 0 only`, async () => {
      const mem = makeMemory();
      setRecord(mem, FINISH, 0xc1, 0);
      mem[0xa9] = 20;
      const { card, pages } = await read(Card, mem);
      assert.deepEqual(pages, [0]);
      assert.equal(card.raceResult.finishCode, undefined);
    });

    test(`${name}: no bit 7, no punches: page 0 only, the record's own code`, async () => {
      const mem = makeMemory();
      setRecord(mem, FINISH, 0x01, 20);
      const { card, pages } = await read(Card, mem);
      assert.deepEqual(pages, [0]);
      assert.equal(card.raceResult.finishCode, 20);
    });
  }
});
