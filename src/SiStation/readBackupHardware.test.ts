// Authored for lool. Not ported from upstream.
//
// Regression tests built from a REAL BSF8 hardware capture (2026-06-01), kept
// as the ground truth for the backup-readout parser. The original readBackup.ts
// was written against a synthetic mock whose byte layout did not match the
// hardware; these tests pin the actual wire shapes.
//
// Capture source + full annotation: __fixtures__/coupled-backup-golden.md
//
// Key facts proven by the capture (see the fixture for byte-by-byte decode):
//   - The pointer read is GET_SYS_VAL with params [0x1C, 0x07]; the response
//     FRAME returned by station.sendMessage() is [cmd, len, CN1, CN0, ADDR,
//     EP3, EP2, xx, xx, xx, EP1, EP0]. The absolute next-free address (pointer)
//     is the big-endian uint32 EP3 EP2 EP1 EP0.
//   - The GET_BACKUP response FRAME is [cmd, len, CN1, CN0, ADR2, ADR1, ADR0,
//     ...128 data]. Records are 8 bytes; card number = bytes 0..2 big-endian;
//     bytes 3..4 are a fixed 0x69 0x69 marker; bytes 5..7 are the punch time.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBackupPointerFrame, parseBackupDataFrame, type BackupRecord } from './readBackup.ts';

// ---------------------------------------------------------------------------
// Real frames as station.sendMessage() returns them: [cmd, len, ...rest].
// These are the exact bytes from the hardware capture, minus STX/CRC/ETX
// (the multiplexer strips those and hands the route [cmd, len, ...params]).
// ---------------------------------------------------------------------------

// RX: 02 83 0a 00 02 1c 00 00 18 04 ff 04 28 73 f3 03
const POINTER_FRAME = [0x83, 0x0a, 0x00, 0x02, 0x1c, 0x00, 0x00, 0x18, 0x04, 0xff, 0x04, 0x28];

// RX: 02 81 85 00 02 00 01 00 <128 data> crc crc 03
// Reassembled 128 data bytes from the 3 RX chunks in the capture.
// Card number = the 3-byte field bytes[0..2], decoded with the CANONICAL SI
// helper arr2cardNumber (LSB-first) — NOT plain big-endian. For legacy SI5
// numbers (high byte ≤ 4) the two differ; the live card-read path uses
// arr2cardNumber, so the backup read MUST match it or the kvar-i-skogen diff
// breaks for those cards (e.g. 0x01413a → 116698 canonical, NOT 82234).
// prettier-ignore
const BACKUP_DATA = [
  0x1a, 0x22, 0xe1, 0x69, 0x69, 0x54, 0x37, 0x54, // r1  1712865
  0x1e, 0x4b, 0xa7, 0x69, 0x69, 0x54, 0x46, 0x09, // r2  1985447
  0x0f, 0xdd, 0xae, 0x69, 0x69, 0x54, 0x4b, 0xa2, // r3  1039790
  0x84, 0xc2, 0xc9, 0x69, 0x69, 0x55, 0x47, 0x12, // r4  8700617 *repeat
  0x01, 0x41, 0x3a, 0x69, 0x69, 0x56, 0x21, 0x0a, // r5  116698 (SI5)
  0x18, 0x54, 0xee, 0x69, 0x69, 0x56, 0x2a, 0xc0, // r6  1594606
  0x84, 0xc2, 0xc9, 0x69, 0x69, 0x56, 0x99, 0xfa, // r7  8700617 *repeat
  0x04, 0x97, 0xd8, 0x69, 0x69, 0x56, 0xb9, 0xb3, // r8  438872 (SI5)
  0x19, 0x5b, 0xed, 0x69, 0x69, 0x57, 0x11, 0x66, // r9  1661933
  0x87, 0xd9, 0xde, 0x69, 0x69, 0x57, 0x7e, 0xfd, // r10 8903134
  0x88, 0xf4, 0xd8, 0x69, 0x69, 0x57, 0x89, 0xad, // r11 8975576
  0x84, 0xc2, 0xc9, 0x69, 0x69, 0x57, 0x8c, 0xe1, // r12 8700617 *repeat
  0x0c, 0xd7, 0x71, 0x69, 0x69, 0x57, 0x96, 0x58, // r13 841585
  0x2d, 0x58, 0xfa, 0x69, 0x69, 0x57, 0xdc, 0xee, // r14 2971898
  0x28, 0x0a, 0xbb, 0x69, 0x69, 0x57, 0xe1, 0x2b, // r15 2624187
  0x2a, 0x20, 0xba, 0x69, 0x69, 0x57, 0xe4, 0xc2, // r16 2760890
];
const BACKUP_FRAME = [0x81, 0x85, 0x00, 0x02, 0x00, 0x01, 0x00, ...BACKUP_DATA];

const EXPECTED_CARDS = [
  1712865, 1985447, 1039790, 8700617, 116698, 1594606, 8700617, 438872, 1661933, 8903134, 8975576,
  8700617, 841585, 2971898, 2624187, 2760890,
];

describe('backup hardware capture', () => {
  test('parseBackupPointerFrame extracts the absolute next-free address', () => {
    const ptr = parseBackupPointerFrame(POINTER_FRAME);
    assert.equal(ptr, 0x428, `expected 0x428 (1064), got 0x${ptr.toString(16)}`);
  });

  test('parseBackupDataFrame strips the 5-byte header and decodes all 16 cards', () => {
    const records = parseBackupDataFrame(BACKUP_FRAME);
    const cards = records.map((r: BackupRecord) => r.cardNumber);
    assert.deepEqual(cards, EXPECTED_CARDS);
  });

  test('parseBackupDataFrame: card 8700617 appears 3×', () => {
    const records = parseBackupDataFrame(BACKUP_FRAME);
    const count = records.filter((r) => r.cardNumber === 8700617).length;
    assert.equal(count, 3, 'card 8700617 punched the start check three times');
  });

  test('parseBackupDataFrame: punch times are monotonically increasing', () => {
    // Sanity that the 8-byte stride is aligned: punch times (bytes 5..7) rise.
    const records = parseBackupDataFrame(BACKUP_FRAME);
    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1]!.rawTime;
      const cur = records[i]!.rawTime;
      assert.ok(cur >= prev, `record ${i} time ${cur} should be >= ${prev}`);
    }
  });

  test('parseBackupDataFrame: empty data frame (header only) yields no records', () => {
    const headerOnly = [0x81, 0x05, 0x00, 0x02, 0x00, 0x01, 0x00];
    assert.deepEqual(parseBackupDataFrame(headerOnly), []);
  });
});
