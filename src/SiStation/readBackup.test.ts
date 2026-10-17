// Authored for lool. Not ported from upstream.
//
// Unit tests for the backup-readout parser + loop, using SYNTHETIC frames that
// match the REAL hardware shape (`[cmd, len, ...payload]`). The byte layout was
// reverse-engineered from a live BSF8 capture — the ground-truth regression
// lives in readBackupHardware.test.ts; this file exercises the loop mechanics
// (block walking, MAX_ITERATIONS cap, empty memory).
//
// Record layout (8 bytes): card = bytes 0..2 (arr2cardNumber, LSB-first);
// bytes 3..4 = 0x69 0x69 marker; bytes 5..7 = punch time.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../constants.ts';
import { cardNumber2arr } from '../siProtocol.ts';
import {
  parseBackupBlock,
  parseBackupPointerFrame,
  parseBackupDataFrame,
  readBackupMemory,
  BLOCK_SIZE,
  MAX_ITERATIONS,
  type BackupRecord,
} from './readBackup.ts';
import type { ISiStation } from './ISiStation.ts';

// ---------------------------------------------------------------------------
// Helpers — build frames the way the hardware/multiplexer hands them over.
// ---------------------------------------------------------------------------

/** Encode a card number into its 3 wire bytes (big-endian), via the canonical
 * cardNumber2arr (LSB-first) reversed — the exact inverse of how we decode. */
function cardBytes(cn: number): [number, number, number] {
  const [b0, b1, b2] = cardNumber2arr(cn); // LSB-first, 4 entries
  return [b2 as number, b1 as number, b0 as number]; // big-endian 3 bytes
}

/** Build a record-data byte run (no header) for the given cards. */
function makeData(cards: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    const [a, b, c] = cardBytes(cards[i]!);
    // bytes 0..2 card, 3..4 marker, 5..7 time (use i as a monotonic stub)
    out.push(a, b, c, 0x69, 0x69, 0x00, 0x00, i & 0xff);
  }
  // Pad to BLOCK_SIZE with zero records (empty slots).
  while (out.length < BLOCK_SIZE) out.push(0x00);
  return out;
}

/** A GET_BACKUP response FRAME: [cmd, len, CN1, CN0, ADR2, ADR1, ADR0, ...data]. */
function backupFrame(cards: number[]): number[] {
  const data = makeData(cards);
  const payload = [0x00, 0x02, 0x00, 0x01, 0x00, ...data];
  return [proto.cmd.GET_BACKUP, payload.length & 0xff, ...payload];
}

/** A GET_SYS_VAL pointer response FRAME for the given absolute pointer.
 * payload = CN1 CN0 ADDR + [EP3 EP2 xx xx xx EP1 EP0]. */
function pointerFrame(pointer: number): number[] {
  const ep3 = (pointer >>> 24) & 0xff;
  const ep2 = (pointer >>> 16) & 0xff;
  const ep1 = (pointer >>> 8) & 0xff;
  const ep0 = pointer & 0xff;
  const payload = [0x00, 0x02, 0x1c, ep3, ep2, 0x00, 0x00, 0x00, ep1, ep0];
  return [proto.cmd.GET_SYS_VAL, payload.length & 0xff, ...payload];
}

/** Mock station that answers GET_SYS_VAL with a pointer frame and each
 * GET_BACKUP with the next scripted block frame (last frame repeats). */
function makeMockStation(
  pointer: number,
  blockFrames: number[][]
): { station: ISiStation; calls: number[] } {
  const calls: number[] = [];
  let blockIdx = 0;
  const station: ISiStation = {
    sendMessage(message) {
      if (!('command' in message)) return Promise.reject(new Error('mode message'));
      calls.push(message.command);
      if (message.command === proto.cmd.GET_SYS_VAL) {
        return Promise.resolve([pointerFrame(pointer)]);
      }
      if (message.command === proto.cmd.GET_BACKUP) {
        const frame = blockFrames[Math.min(blockIdx++, blockFrames.length - 1)]!;
        return Promise.resolve([frame]);
      }
      return Promise.resolve([[]]);
    },
  };
  return { station, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backup parser', () => {
  test('parseBackupPointerFrame reads the absolute pointer', () => {
    assert.equal(parseBackupPointerFrame(pointerFrame(0x428)), 0x428);
    assert.equal(parseBackupPointerFrame(pointerFrame(0x100)), 0x100);
  });

  test('parseBackupDataFrame strips the 5-byte header and decodes cards', () => {
    const frame = backupFrame([1083339, 7524126, 8700617]);
    const cards = parseBackupDataFrame(frame).map((r: BackupRecord) => r.cardNumber);
    assert.deepEqual(cards, [1083339, 7524126, 8700617]);
  });

  test('parseBackupBlock skips zero-card (empty) slots', () => {
    const data = makeData([320541]); // one card then zero-padding
    const records = parseBackupBlock(new Uint8Array(data), proto.REC_LEN);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.cardNumber, 320541);
  });

  test('parseBackupBlock ignores a trailing partial record', () => {
    const data = makeData([320541]).slice(0, 12); // 1 full record + 4 stray bytes
    const records = parseBackupBlock(new Uint8Array(data), proto.REC_LEN);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.cardNumber, 320541);
  });

  test('readBackupMemory: GET_SYS_VAL pointer then GET_BACKUP walk from 0x100', async () => {
    // pointer 0x100 + 256 bytes → 2 blocks.
    const pointer = 0x100 + 256;
    const { station, calls } = makeMockStation(pointer, [
      backupFrame([1083339, 7524126]),
      backupFrame([320541]),
    ]);

    const result = await readBackupMemory(station);
    assert.equal(result.overflow, false);
    assert.equal(calls[0], proto.cmd.GET_SYS_VAL);
    assert.equal(calls[1], proto.cmd.GET_BACKUP);
    assert.equal(calls[2], proto.cmd.GET_BACKUP);
    const cards = result.records.map((r) => r.cardNumber);
    assert.ok(cards.includes(1083339));
    assert.ok(cards.includes(7524126));
    assert.ok(cards.includes(320541));
  });

  test('readBackupMemory: empty memory (pointer at base) → no records, no GET_BACKUP', async () => {
    const { station, calls } = makeMockStation(0x100, [backupFrame([])]);
    const result = await readBackupMemory(station);
    assert.equal(result.records.length, 0);
    assert.ok(!calls.includes(proto.cmd.GET_BACKUP), 'must not read backup when empty');
  });

  test('readBackupMemory: caps loop at MAX_ITERATIONS and sets overflow', async () => {
    const pointer = 0x100 + (MAX_ITERATIONS + 10) * BLOCK_SIZE;
    const { station } = makeMockStation(pointer, [backupFrame([12345])]);
    const result = await readBackupMemory(station);
    assert.equal(result.overflow, true);
    assert.equal(result.records.length, MAX_ITERATIONS); // 1 card per capped block
  });
});
