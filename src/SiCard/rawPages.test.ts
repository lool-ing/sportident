// Authored for lool. Not ported from upstream.
//
// card.rawPages(): the snapshot equals what the station returned, is a copy,
// and RAW_LAYOUTS' personal-data ranges never overlap a race field.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import { proto } from '../constants.ts';
import { parseAll, type SiMessage } from '../siProtocol.ts';
import { NdjsonEmitter } from '../output/ndjson.ts';
import { BaseSiCard } from './BaseSiCard.ts';
import { decodeRawPages } from './decodeRawPages.ts';
import { VERSION } from '../version.ts';
import { RAW_BLOCK_SIZE, RAW_LAYOUTS, type RawPages } from './rawPages.ts';
import { SiCard5 } from './types/SiCard5.ts';
import { SiCard6 } from './types/SiCard6.ts';
import { SiCard8 } from './types/SiCard8.ts';
import { SiCard9 } from './types/SiCard9.ts';
import { SiCard10 } from './types/SiCard10.ts';
import { SiCard11 } from './types/SiCard11.ts';
import { SIAC } from './types/SIAC.ts';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const BENCH = path.resolve(HERE, '..', '..', 'tests', 'fixtures', 'bench');

const SLUGS: ReadonlyArray<{ slug: string; type: keyof typeof RAW_LAYOUTS }> = [
  { slug: 'si5', type: 'SI5' },
  { slug: 'si6', type: 'SI6' },
  { slug: 'si8', type: 'SI8' },
  { slug: 'si9', type: 'SI9' },
  { slug: 'si10', type: 'SI10' },
  { slug: 'siac', type: 'SIAC' },
];

interface Bench {
  card: BaseSiCard;
  /** Blocks the card asked for and the mock station delivered, block -> bytes. */
  delivered: Map<number, number[]>;
}

/** Read a bench transcript's card through a mock station that answers from the
 * transcript's `in` frames; a page it does not carry is an erased (0xEE) page,
 * like replay's legacyErasedPageReply. Records what it delivered, so the test
 * follows the reader's block choice instead of the recording's. */
const isIn = (list: readonly number[], c: number): boolean => list.includes(c);

const readBench = async (slug: string): Promise<Bench> => {
  const text = fs.readFileSync(path.join(BENCH, `${slug}-bench-001.bytes.hex`), 'utf8');
  const stream: number[] = [];
  for (const line of text.split('\n')) {
    const m = /^in\s+([0-9A-Fa-f ]+)$/.exec(line.trim());
    if (m) stream.push(...m[1]!.split(/\s+/).map((h) => parseInt(h, 16)));
  }
  const messages = parseAll(stream).messages.filter((m) => m.mode === undefined) as Array<
    Extract<SiMessage, { parameters: number[] }>
  >;
  const det = messages.find((m) =>
    isIn([proto.cmd.SI5_DET, proto.cmd.SI6_DET, proto.cmd.SI8_DET], m.command)
  )!;
  const card = BaseSiCard.detectFromMessage(det)!;
  const delivered = new Map<number, number[]>();
  const replies = new Map<string, number[]>();
  for (const m of messages) {
    if (!isIn([proto.cmd.GET_SI5, proto.cmd.GET_SI6, proto.cmd.GET_SI8], m.command)) continue;
    const isSi5 = m.command === proto.cmd.GET_SI5;
    const block = isSi5 ? 0 : m.parameters[2]!;
    replies.set(`${m.command}:${block}`, [m.command, m.parameters.length, ...m.parameters]);
  }
  card.mainStation = {
    sendMessage: (message: SiMessage) => {
      const command = (message as { command: number }).command;
      const block =
        command === proto.cmd.GET_SI5 ? 0 : (message as { parameters: number[] }).parameters[0]!;
      const reply = replies.get(`${command}:${block}`) ?? [
        command,
        131,
        0x00,
        0x0a,
        block,
        ...new Array<number>(RAW_BLOCK_SIZE).fill(0xee),
      ];
      delivered.set(block, reply.slice(command === proto.cmd.GET_SI5 ? 4 : 5));
      return Promise.resolve([reply]);
    },
  };
  await card.read();
  return { card, delivered };
};

const sameBytes = (a: Uint8Array, b: ArrayLike<number>): boolean =>
  a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

describe('rawPages snapshot equals the bench transcripts', () => {
  for (const { slug, type } of SLUGS) {
    test(`${slug}-bench-001`, async () => {
      const { card, delivered } = await readBench(slug);
      const raw = card.rawPages();
      assert.strictEqual(raw.cardType, type);
      assert.strictEqual(raw.layout, RAW_LAYOUTS[type].layout);
      const blocks = new Map(raw.blocks.map((b) => [b.block, b.bytes]));
      assert.deepStrictEqual(
        raw.blocks.map((b) => b.block),
        [...blocks.keys()].sort((a, b) => a - b)
      );
      // Exactly the blocks the reader asked for, with the bytes the station sent.
      assert.deepStrictEqual(
        [...blocks.keys()].sort((a, b) => a - b),
        [...delivered.keys()].sort((a, b) => a - b)
      );
      for (const [block, bytes] of delivered) {
        assert.strictEqual(bytes.length, RAW_BLOCK_SIZE);
        assert.ok(sameBytes(blocks.get(block)!, bytes), `block ${block} bytes`);
      }
    });
  }

  test('a card that was never read has no blocks', () => {
    assert.deepStrictEqual(new SIAC(0).rawPages().blocks, []);
  });

  test('the snapshot is a copy', async () => {
    const card = (await readBench('siac')).card as SIAC;
    const first = card.rawPages();
    const frozen = structuredClone(first);
    first.blocks[0]!.bytes.fill(0x55);
    first.blocks.pop();
    card.storage.splice(0, 1, 0xaa);
    const second = card.rawPages();
    assert.strictEqual(second.blocks[0]!.bytes[0], 0xaa);
    assert.ok(sameBytes(second.blocks[0]!.bytes.subarray(1), frozen.blocks[0]!.bytes.subarray(1)));
    assert.strictEqual(second.blocks.length, frozen.blocks.length);
    assert.notStrictEqual(second.blocks[0]!.bytes, first.blocks[0]!.bytes);
    const third = card.rawPages();
    third.blocks[0]!.bytes[5] = 0x77;
    assert.notStrictEqual(card.rawPages().blocks[0]!.bytes[5], 0x77);
  });

  test('--include-raw-pages: NDJSON carries base64 per block, default does not', async () => {
    const { card } = await readBench('si9');
    const lines: string[] = [];
    new NdjsonEmitter({ device_path: '/dev/x', out: (l) => lines.push(l) }).card_read({ card });
    new NdjsonEmitter({
      device_path: '/dev/x',
      out: (l) => lines.push(l),
      includeRawPages: true,
    }).card_read({ card });
    const [plain, withRaw] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.strictEqual(plain!.raw_pages, undefined);
    const rp = withRaw!.raw_pages as { layout: string; blocks: { block: number; b64: string }[] };
    assert.strictEqual(rp.layout, 'si9');
    const raw = card.rawPages();
    assert.deepStrictEqual(
      rp.blocks.map((b) => [b.block, b.b64]),
      raw.blocks.map((b) => [b.block, Buffer.from(b.bytes).toString('base64')])
    );
    delete withRaw!.raw_pages;
    assert.deepStrictEqual(withRaw, { ...plain, ts_ms: withRaw!.ts_ms });
  });
});

// --- personal-data ranges ---------------------------------------------------

type Ctor = new (
  n: number
) => BaseSiCard & { decodeFromStorage: (b: (number | undefined)[]) => void };
const CLASSES: Record<string, Ctor> = {
  SI5: SiCard5,
  SI6: SiCard6,
  SI8: SiCard8,
  SI9: SiCard9,
  SI10: SiCard10,
  SI11: SiCard11,
  SIAC,
} as unknown as Record<string, Ctor>;

const toImage = (raw: RawPages): (number | undefined)[] => {
  const image: (number | undefined)[] = new Array<number | undefined>(0x400).fill(undefined);
  for (const b of raw.blocks) b.bytes.forEach((v, i) => (image[b.block * RAW_BLOCK_SIZE + i] = v));
  return image;
};

/** Everything a consumer takes from a card except the holder text and the UID. */
const race = (type: string, image: (number | undefined)[]): unknown => {
  const card = new CLASSES[type]!(0);
  card.decodeFromStorage(image.slice());
  const result: Record<string, unknown> = { ...card.raceResult };
  delete result.cardHolder;
  return { result, punchCount: (card as { punchCount?: number }).punchCount };
};

const fill = (
  image: (number | undefined)[],
  type: keyof typeof RAW_LAYOUTS,
  value: () => number
) => {
  const out = image.slice();
  for (const r of RAW_LAYOUTS[type].personal) {
    for (let a = r.from; a <= r.to; a++)
      if (out[a] !== undefined || type !== 'SI5') out[a] = value();
  }
  return out;
};

const random = (): number => Math.floor(Math.random() * 256);

describe('personal-data ranges leave the race fields alone', () => {
  for (const { slug, type } of SLUGS) {
    test(`${type}: bench image, holder random vs zeroed`, async () => {
      const image = toImage((await readBench(slug)).card.rawPages());
      for (let i = 0; i < 20; i++) {
        assert.deepStrictEqual(
          race(type, fill(image, type, random)),
          race(
            type,
            fill(image, type, () => 0)
          )
        );
      }
      assert.deepStrictEqual(
        race(
          type,
          fill(image, type, () => 0)
        ),
        race(type, image)
      );
    });
  }

  test('SIAC synthetic: firmware 4 block-1 codes, reserve records and punches survive', async () => {
    const image = toImage((await readBench('siac')).card.rawPages());
    image.fill(0xee, 0x80, 0x100); // block 1
    image.fill(0xee, 0x180, 0x200); // block 3
    image[0x1c2] = 4;
    image[0x1c3] = 0;
    image.splice(0x0c, 8, 0x01, 0x1e, 0x20, 0x10, 0x01, 0x1d, 0x21, 0x11); // start, finish records
    image.splice(0xa4, 6, 0, 0x1f, 0, 0, 0, 0x20); // 0xA5 start code, 0xA9 finish code
    image.splice(0x1d8, 8, 0x00, 0x21, 0x10, 0x00, 0x00, 0x22, 0x11, 0x00); // start_r, finish_r
    const a = race('SIAC', fill(image, 'SIAC', random));
    const b = race(
      'SIAC',
      fill(image, 'SIAC', () => 0)
    );
    assert.deepStrictEqual(a, b);
    const result = (a as { result: Record<string, unknown> }).result;
    assert.strictEqual(result.startCode, 0x1f);
    assert.strictEqual(result.finishCode, 0x20);
    assert.ok(result.startFirstTime !== undefined && result.finishFirstTime !== undefined);
  });

  test('SI5, SI8, SI9 synthetic: punches next to the holder survive', () => {
    const si5 = new Array<number>(0x80).fill(0);
    si5.splice(0x04, 3, 0x00, 0x0a, 0x00); // card number bytes at 0x04..0x06
    si5[0x17] = 3; // punchCount + 1
    si5.splice(0x20, 4, 0x5a, 0x10, 0x20, 0x30);
    const modern = (punchesAt: number): number[] => {
      const img = new Array<number>(0x100).fill(0xee);
      img.fill(0, 0x00, 0x20);
      img[0x16] = 2;
      img.splice(punchesAt, 8, 0x1f, 0x00, 0x10, 0x20, 0x20, 0x00, 0x11, 0x21);
      return img;
    };
    for (const [type, img] of [
      ['SI5', si5],
      ['SI8', modern(0x88)],
      ['SI9', modern(0x38)],
    ] as const) {
      const a = race(type, fill(img, type, random));
      assert.deepStrictEqual(
        a,
        race(
          type,
          fill(img, type, () => 0)
        )
      );
      assert.ok(((a as { result: { punches?: unknown[] } }).result.punches ?? []).length > 0, type);
    }
  });

  test('SI6 synthetic: holder text next to the clear record, times and punches survive', () => {
    const img = new Array<number>(0x400).fill(0xee);
    img.splice(0x0b, 3, 0x07, 0xa1, 0x20); // card number
    img[0x12] = 2; // punch count
    // finish, start, check and clear records: [ptd, code, time_hi, time_lo]
    img.splice(0x14, 12, 0x01, 0x20, 0x11, 0x00, 0x01, 0x1f, 0x10, 0x00, 0x01, 0x05, 0x0f, 0x00);
    img.splice(0x20, 4, 0x01, 0x00, 0x0e, 0x00);
    img.splice(0x300, 8, 0x01, 0x1f, 0x10, 0x20, 0x01, 0x20, 0x10, 0x30);
    const withHolder = img.slice();
    for (let a = 0x30; a <= 0xfb; a++) withHolder[a] = 0x41 + (a % 26); // holder text
    const a = race('SI6', withHolder);
    assert.deepStrictEqual(
      a,
      race(
        'SI6',
        fill(withHolder, 'SI6', () => 0)
      )
    );
    assert.deepStrictEqual(a, race('SI6', fill(withHolder, 'SI6', random)));
    const result = (a as { result: Record<string, unknown> }).result;
    assert.strictEqual((result.punches as unknown[]).length, 2);
    for (const k of ['startTime', 'finishTime', 'checkTime', 'clearTime'])
      assert.ok(typeof result[k] === 'number', k);
  });

  test('SI6 lists its holder ranges; every layout is verified', () => {
    assert.deepStrictEqual(RAW_LAYOUTS.SI6.personal, [
      { kind: 'holder', from: 0x28, to: 0x7f },
      { kind: 'holder', from: 0x80, to: 0xfb },
    ]);
    for (const t of Object.keys(RAW_LAYOUTS) as (keyof typeof RAW_LAYOUTS)[]) {
      assert.strictEqual(RAW_LAYOUTS[t].personalRangesVerified, true, t);
    }
  });
});

describe('decodeRawPages', () => {
  for (const { slug, type } of SLUGS) {
    test(`${slug}-bench-001 decodes like the original read`, async () => {
      const { card } = await readBench(slug);
      const decoded = decodeRawPages(card.rawPages());
      assert.strictEqual(decoded.cardType, type);
      assert.deepStrictEqual(decoded.raceResult, card.raceResult);
      assert.strictEqual(decoded.raceResult.punches?.length, card.raceResult.punches?.length);
      // Fields the decoders set on the card itself, outside raceResult.
      for (const key of ['punchCount', 'uid', 'cardSeries', 'softwareVersion'] as const) {
        assert.strictEqual(
          (decoded as unknown as Record<string, unknown>)[key],
          (card as unknown as Record<string, unknown>)[key],
          key
        );
      }
    });
  }

  test('rejects an unknown card type', () => {
    assert.throws(
      () => decodeRawPages({ cardType: 'SI99' as never, layout: 'si8', blocks: [] }),
      /unknown card type SI99/
    );
    assert.throws(
      () => decodeRawPages({ cardType: 'toString' as never, layout: 'si8', blocks: [] }),
      /unknown card type/
    );
  });

  test('rejects a block number outside the card, not whole, or repeated', () => {
    const block = (n: number) => ({ block: n, bytes: new Uint8Array(RAW_BLOCK_SIZE) });
    for (const blocks of [[block(-1)], [block(1)], [block(0.5)], [block(0), block(0)]]) {
      assert.throws(
        () => decodeRawPages({ cardType: 'SI5', layout: 'si5', blocks }),
        /is not a single block 0-0 of SI5/
      );
    }
    assert.throws(
      () => decodeRawPages({ cardType: 'SIAC', layout: 'modern', blocks: [block(8)] }),
      /block 8 is not a single block 0-7 of SIAC/
    );
  });

  test('rejects a layout that does not belong to the card type', () => {
    const blocks = [{ block: 0, bytes: new Uint8Array(RAW_BLOCK_SIZE) }];
    assert.throws(
      () => decodeRawPages({ cardType: 'SI8', layout: 'si5', blocks }),
      /layout si5 does not match SI8/
    );
  });

  test('rejects a snapshot without block 0 (the card number)', () => {
    const blocks = [{ block: 1, bytes: new Uint8Array(RAW_BLOCK_SIZE) }];
    assert.throws(
      () => decodeRawPages({ cardType: 'SI8', layout: 'si8', blocks }),
      /block 0 .*card number/
    );
    assert.throws(
      () => decodeRawPages({ cardType: 'SI5', layout: 'si5', blocks: [] }),
      /block 0 .*card number/
    );
  });

  test('decodeFromStorage is a typed method on BaseSiCard', async () => {
    const { card } = await readBench('si8');
    const typed: BaseSiCard = new SiCard8(0);
    typed.decodeFromStorage(toImage(card.rawPages()));
    assert.deepStrictEqual(typed.raceResult, card.raceResult);
  });

  test('rejects a block that is not 128 bytes', () => {
    assert.throws(
      () =>
        decodeRawPages({
          cardType: 'SI8',
          layout: 'si8',
          blocks: [{ block: 0, bytes: new Uint8Array(64) }],
        }),
      /block 0 has 64 bytes/
    );
  });

  test('rejects input that is not RawPages-shaped', () => {
    const base = { cardType: 'SI8', layout: 'si8' } as const;
    // an NDJSON block passed as is
    assert.throws(
      () => decodeRawPages({ ...base, blocks: [{ block: 0, b64: 'AAAA' }] } as unknown as RawPages),
      /Uint8Array/
    );
    assert.throws(() => decodeRawPages(base as unknown as RawPages), /blocks must be an array/);
    // number[] with a value that does not fit a byte
    const numbers = new Array<number>(RAW_BLOCK_SIZE).fill(0);
    numbers[0] = 300;
    assert.throws(
      () =>
        decodeRawPages({ ...base, blocks: [{ block: 0, bytes: numbers }] } as unknown as RawPages),
      /Uint8Array/
    );
  });

  test('rejects a missing punch block instead of returning no punches', () => {
    const page = (set: (b: Uint8Array) => void): Uint8Array => {
      const b = new Uint8Array(RAW_BLOCK_SIZE);
      set(b);
      return b;
    };
    const cases: Array<[RawPages['cardType'], RawPages['layout'], number, number]> = [
      ['SI6', 'si6', 0x12, 6],
      ['SI8', 'si8', 0x16, 1],
      ['SI10', 'modern', 0x16, 4],
      ['SIAC', 'modern', 0x16, 4],
    ];
    for (const [cardType, layout, countAt, punchBlock] of cases) {
      const block0 = page((b) => (b[countAt] = 2));
      const withoutPunches = { cardType, layout, blocks: [{ block: 0, bytes: block0 }] };
      assert.throws(() => decodeRawPages(withoutPunches), /punch/, cardType);
      // no punches on the card: block 0 alone is complete
      const none = page(() => {});
      assert.doesNotThrow(() =>
        decodeRawPages({ cardType, layout, blocks: [{ block: 0, bytes: none }] })
      );
      assert.ok(punchBlock > 0);
    }
  });

  test('all punch blocks present decodes even when the decoder stops at an invalid slot', () => {
    const img = new Array<number>(0x100).fill(0);
    img[0x16] = 3;
    img.fill(0xee, 0x88 + 4, 0x88 + 8); // slot 1 invalid, slot 2 valid
    img.splice(0x88, 4, 0x1f, 0x00, 0x10, 0x20);
    img.splice(0x88 + 8, 4, 0x20, 0x00, 0x11, 0x21);
    const card = decodeRawPages({
      cardType: 'SI8',
      layout: 'si8',
      blocks: [0, 1].map((block) => ({
        block,
        bytes: Uint8Array.from(img.slice(block * RAW_BLOCK_SIZE, (block + 1) * RAW_BLOCK_SIZE)),
      })),
    });
    assert.strictEqual(card.punchCount, 3);
    assert.ok((card.raceResult.punches?.length ?? 3) < 3);
  });
});

test('VERSION equals package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', '..', 'package.json'), 'utf8'));
  assert.strictEqual(VERSION, pkg.version);
});
