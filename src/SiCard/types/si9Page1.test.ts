// Authored for lool. Not ported from upstream.
// SI9 page 0 holds the header, the card holder and punches 1-18 (0x38-0x7F);
// page 1 only punches 19-50. With 18 punches or fewer the live read skips
// page 1 and must still decode exactly what the whole memory decodes, also
// when page 1 holds old records past the punch count.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../../constants.ts';
import type { SiMessage } from '../../siProtocol.ts';
import { SiCard9 } from './SiCard9.ts';

const BYTES_PER_PAGE = 128;

/** An SI9 image: `n` punches, a filled card holder, and every slot after the
 * count (through page 1) holding an old punch record (codes 200 and up). */
const image = (n: number): number[] => {
  const mem = new Array<number>(0x100).fill(0xee);
  const holder = 'Anna;Andersson;Club;';
  for (let i = 0; i < holder.length; i++) mem[0x20 + i] = holder.charCodeAt(i);
  mem[0x16] = n;
  for (let i = 0; i < 50; i++) {
    const old = i >= n;
    mem.splice(0x38 + 4 * i, 4, 0x0c, old ? 200 + (i - n) : 31 + i, 0x0e, old ? 0x20 : 0x10);
  }
  return mem;
};

const liveRead = async (mem: number[]): Promise<{ pages: number[]; card: SiCard9 }> => {
  const card = new SiCard9(0);
  const pages: number[] = [];
  card.mainStation = {
    sendMessage: async (msg: SiMessage) => {
      if (msg.mode !== undefined) return [];
      const page = msg.parameters[0]!;
      pages.push(page);
      const data = mem.slice(page * BYTES_PER_PAGE, (page + 1) * BYTES_PER_PAGE);
      return [[proto.cmd.GET_SI8, BYTES_PER_PAGE + 3, 0x00, 0x0a, page, ...data]];
    },
  } as unknown as NonNullable<SiCard9['mainStation']>;
  await card.typeSpecificRead();
  return { pages, card };
};

const fullDecode = (mem: number[]): SiCard9 => {
  const card = new SiCard9(0);
  card.decodeFromStorage(mem);
  return card;
};

describe('SI9 page 1', () => {
  for (const [n, pages] of [
    [0, [0]],
    [1, [0]],
    [17, [0]],
    [18, [0]],
    [19, [0, 1]],
    [32, [0, 1]],
    [50, [0, 1]],
  ] as const) {
    test(`${n} punches: reads pages ${pages.join(', ')}; same result as the whole memory`, async () => {
      const mem = image(n);
      const { pages: read, card } = await liveRead(mem);
      assert.deepEqual(read, pages);
      assert.deepEqual(card.raceResult, fullDecode(mem).raceResult);
      assert.equal((card.raceResult.punches ?? []).length, n);
      assert.ok(
        (card.raceResult.punches ?? []).every((p) => p.code < 200),
        'no old record past the count'
      );
    });
  }
});
