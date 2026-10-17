// Authored for lool. Not ported from upstream.
//
// Block-1 audit (bytes 0x80-0xFF, page 1) for SI8, SI9, SI10/SI11/SIAC: a
// live read through a fake station must decode exactly what a full-memory
// decode of the same image gives, whatever block 1 holds. Any field that
// depends on block 1 and is not fetched would show up as a difference.
// Fields that read block 1 (see https://github.com/lool-ing/lool/issues/25):
//   - card holder bytes 0x80-0x9F (SI10/11/SIAC; fetched when the holder in
//     page 0 is incomplete)
//   - station code of a PTD bit-7 start/finish record: 0xA5 / 0xA9 (SI8 and
//     newer; MeOS behaviour, SportIdent.cpp:1929). A check record keeps CN.
//   - punches 0x88.. (SI8) and 0x38..0xFF (SI9; punches from 0x80 on)
//     (documented, SPORTident card data structure doc, provided on request)
// Deterministic pseudo-random images, so a failure is reproducible.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../../constants.ts';
import type { SiMessage } from '../../siProtocol.ts';
import { SiCard10 } from './SiCard10.ts';
import { SiCard8 } from './SiCard8.ts';
import { SiCard9 } from './SiCard9.ts';

const BYTES_PER_PAGE = 128;

const CARDS = [
  // name, class, memory size, card holder bytes at 0x20, first punch offset
  ['SI10', SiCard10, 0x400, 0x80, 0x200],
  ['SI9', SiCard9, 0x100, 0x18, 0x38],
  ['SI8', SiCard8, 0x100, 0x60, 0x88],
] as const;

describe('live read == full-memory decode (block 1 is fetched whenever it matters)', () => {
  for (const [name, Card, size, holderBytes, punchBase] of CARDS) {
    test(`${name}: 2000 random images`, async () => {
      let seed = 12345;
      const rnd = (n: number): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed >>> 8) % n;
      };
      for (let it = 0; it < 2000; it++) {
        const mem = new Array<number>(size).fill(0xee);
        const fields = Array.from({ length: rnd(14) }, () => 'ab'.repeat(rnd(12)));
        const holder = fields.join(';') + (rnd(2) ? ';' : '');
        for (let i = 0; i < holder.length && i < holderBytes; i++)
          mem[0x20 + i] = holder.charCodeAt(i);
        const punches = rnd(5) === 0 ? 0 : rnd(30);
        mem[0x16] = punches;
        for (let i = 0; i < punches && punchBase + 4 * i + 4 <= size; i++)
          mem.splice(punchBase + 4 * i, 4, 1, 31 + i, 0x0e, 0x10);
        for (const record of [0x0c, 0x10, 0x08]) {
          if (rnd(3) === 0) continue;
          const ptd = (rnd(2) ? 0x80 : 0) | (rnd(2) ? 0x40 : 0) | rnd(2);
          mem.splice(record, 4, ptd, rnd(256), 0x0e, 0x10);
        }
        for (const beacon of [0xa5, 0xa9, 0xa1]) mem[beacon] = rnd(2) ? rnd(256) : 0xee;

        const full = new Card(0);
        full._decodeFromStorage(mem);
        const live = new Card(0);
        live.mainStation = {
          sendMessage: async (msg: SiMessage) => {
            if (msg.mode !== undefined) return [];
            const page = msg.parameters[0]!;
            const data = mem.slice(page * BYTES_PER_PAGE, (page + 1) * BYTES_PER_PAGE);
            return [[proto.cmd.GET_SI8, BYTES_PER_PAGE + 3, 0x00, 0x0a, page, ...data]];
          },
        } as unknown as NonNullable<SiCard10['mainStation']>;
        await live.typeSpecificRead();
        assert.deepEqual(live.raceResult, full.raceResult, `image ${it}`);
      }
    });
  }
});
