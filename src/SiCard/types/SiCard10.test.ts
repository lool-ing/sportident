// Authored for lool. Not ported from upstream.
// Fixtures from tests/fixtures/upstream/.
// Covers: (1) storage decode, (2) SI8_DET dispatch to SiCard10, (3) cross-registry
// safety, (4) multi-page punch read sequence.
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../../constants.ts';
import { type SiMessage } from '../../siProtocol.ts';
import { BaseSiCard } from '../BaseSiCard.ts';
// Importing types module triggers the side-effect registrations on BaseSiCard.
import { SiCard10 } from './SiCard10.ts';
import './SiCard9.ts';
import './SIAC.ts';
import './SiCard5.ts';
import { fixture as si10 } from '../../../tests/fixtures/upstream/si10-typical.ts';
import { fixture as si10many } from '../../../tests/fixtures/upstream/si10-many-punches.ts';

function decodeSi10(storage: (number | undefined)[]): { [k: string]: unknown } {
  const card = new SiCard10(0);
  card._decodeFromStorage(storage);
  return {
    uid: card.uid,
    cardSeries: card.cardSeries,
    cardNumber: card.raceResult.cardNumber,
    startTime: card.raceResult.startTime ?? null,
    finishTime: card.raceResult.finishTime ?? null,
    checkTime: card.raceResult.checkTime ?? null,
    punchCount: card.punchCount,
    punches: card.raceResult.punches,
    cardHolder: card.raceResult.cardHolder,
  };
}

// Build a synthetic SI8_DET frame with the given card number in params[3..5]
// and series byte at params[2]. Upstream's params layout (cf. ModernSiCard):
//   parameters[2] = seriesByte
//   parameters[3] = cardNumber high byte (b19 in storage)
//   parameters[4] = cardNumber middle byte (b1A)
//   parameters[5] = cardNumber low byte (b1B)
// `arr2cardNumber([params[5], params[4], params[3]])` reconstructs the number.
function makeSi8DetMessage(seriesByte: number, b19: number, b1A: number, b1B: number): SiMessage {
  return {
    command: proto.cmd.SI8_DET,
    parameters: [0x00, 0x00, seriesByte, b19, b1A, b1B],
  };
}

describe('SiCard10 decoder — upstream fixture', () => {
  test('1) SI10-typical fixture decodes byte-for-byte to expected cardData', () => {
    const decoded = decodeSi10(si10.storageData);
    assert.deepStrictEqual(decoded, si10.cardData);
  });

  test('2) detectFromMessage(SI8_DET, cardNumber in SI10 range) -> SiCard10 instance', () => {
    // 7050892 = 0x6B968C -> bytes: b19=0x6B, b1A=0x96, b1B=0x8C
    const msg = makeSi8DetMessage(0x0f, 0x6b, 0x96, 0x8c);
    const card = BaseSiCard.detectFromMessage(msg);
    assert.ok(
      card instanceof SiCard10,
      'expected SiCard10 instance, got ' + card?.constructor.name
    );
    assert.strictEqual(card.cardNumber, 7050892);
    assert.strictEqual(card.cardSeriesByte, 0x0f);
  });

  test('3) cross-registry safety: SI8_DET with cardNumber 50000 -> undefined (NOT SiCard5)', () => {
    // 50000 = 0x00C350 -> bytes: b19=0x00, b1A=0xC3, b1B=0x50.
    // arr2cardNumber([0x50, 0xC3, 0x00]) when arr[2]=0 and length=3 -> cardnum = (0xC3<<8)|0x50 = 50000
    const msg = makeSi8DetMessage(0x01, 0x00, 0xc3, 0x50);
    const card = BaseSiCard.detectFromMessage(msg);
    // 50000 falls in SiCard5's range (1000..500000) on the SI5 registry, but the
    // detection command here is SI8_DET so the SI5 registry is never consulted.
    // No SI8 registry entry covers 50000 (SI9 starts at 1M), so the result is undefined.
    assert.strictEqual(card, undefined);
  });

  test('4) multi-page chain: typeSpecificRead issues GET_SI8 [0x04] AND [0x05] for >32 punches', async () => {
    // Drive ModernSiCard.typeSpecificRead via a recording mock station that returns
    // pages from the >32-punches fixture (page 0 carries punchCount=64).
    const card = new SiCard10(0);
    const recorded: { command: number; parameters: number[] }[] = [];
    const bytesPerPage = 128;
    card.mainStation = {
      sendMessage: async (msg: SiMessage) => {
        if (msg.mode !== undefined) return [];
        recorded.push({ command: msg.command, parameters: [...msg.parameters] });
        const pageNumber = msg.parameters[0];
        if (pageNumber === undefined) throw new Error('mock: missing pageNumber');
        // Slice the page out of the fixture's storageData; prepend a 5-byte fake
        // response header [cmd, len, addr_hi, addr_lo, pageNo] matching the
        // real-wire response shape (bench transcript 2026-05-13 from
        // /dev/ttyUSB0). ModernSiCard.typeSpecificGetPage does frame.slice(5)
        // so the splice receives exactly 128 data bytes.
        const pageBytes = si10many.storageData.slice(
          pageNumber * bytesPerPage,
          (pageNumber + 1) * bytesPerPage
        );
        return [
          [proto.cmd.GET_SI8, bytesPerPage + 3, 0x00, 0x0a, pageNumber, ...(pageBytes as number[])],
        ];
      },
    };

    await card.typeSpecificRead();

    // Page 4 MUST be requested for any card with punches,
    // and page 5 MUST be requested when punchCount > 32.
    const get_si8_pages = recorded
      .filter((m) => m.command === proto.cmd.GET_SI8)
      .map((m) => m.parameters[0]);
    assert.ok(
      get_si8_pages.includes(0x04),
      `expected page 0x04 in ${JSON.stringify(get_si8_pages)}`
    );
    assert.ok(
      get_si8_pages.includes(0x05),
      `expected page 0x05 in ${JSON.stringify(get_si8_pages)}`
    );
    // Punch count from page 0 should propagate.
    assert.strictEqual(card.punchCount, 64);
    assert.strictEqual(card.raceResult.punches?.length, 64);
  });

  test('5) a GET_SI8 reply for another page is an error, not data', async () => {
    // A stale or misrouted reply (eg the next card's page 0) must never be
    // spliced in as the requested page.
    const card = new SiCard10(0);
    card.mainStation = {
      sendMessage: async () => [
        [proto.cmd.GET_SI8, 128 + 3, 0x00, 0x0a, 0x00, ...new Array<number>(128).fill(0x22)],
      ],
    };
    await assert.rejects(() => card.typeSpecificGetPage(4), /page 0 \(expected 4\)/);
  });
});
